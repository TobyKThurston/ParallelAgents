/**
 * Shop Swarm — a deliberately-buggy multi-page Next.js-like shop served as plain
 * HTML pages over node:http. Used as the target app for the adversarial fork swarm.
 *
 * Planted bugs:
 *   [1] Home: double-click "Add to cart" adds 2 items (client race)
 *   [2] Cart: quantity input has no server-side validation (negative qty / overflow)
 *   [3] Checkout: POST has no email validation — missing email → 500
 *   [4] Checkout: concurrent POSTs create duplicate orders (no idempotency)
 *   [5] Success page: customer name rendered via innerHTML (XSS reflection)
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'

type CartItem = { sku: string; price: number; qty: number }
type Order = { orderId: string; sid: string; items: CartItem[]; email: string; name: string; total: number; at: number }
type Session = { sid: string; orders: Order[] }

const PRODUCTS = [
  { sku: 'widget',   name: 'Widget',   price: 10, emoji: '🧩' },
  { sku: 'gadget',   name: 'Gadget',   price: 25, emoji: '⚙️' },
  { sku: 'sprocket', name: 'Sprocket', price: 5,  emoji: '🔩' },
]

function baseHead(title: string, bannerColor?: string): string {
  return `<!doctype html>
<html><head>
<title>${title} — Shop Swarm</title>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; background:#0f0f10; color:#eaeaea; margin:0; }
  .nav { display:flex; justify-content:space-between; align-items:center; padding:1rem 2rem; border-bottom:1px solid #222; background:#141415; }
  .nav .logo { font-weight: 800; letter-spacing: -0.02em; font-size: 1.1rem; }
  .nav .logo span { color: #a78bfa; }
  .nav a { color:#aaa; text-decoration:none; margin:0 0.75rem; font-size: 0.9rem; }
  .nav a:hover { color:#fff; }
  .nav .cart-chip { background:#1e1e22; border:1px solid #333; padding:0.35rem 0.8rem; border-radius:999px; color:#eaeaea; }
  .page { max-width: 960px; margin: 0 auto; padding: 2.5rem 2rem; }
  h1 { letter-spacing: -0.03em; }
  .products { display:grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
  .card { background:#141415; border:1px solid #222; border-radius:0.75rem; padding:1.5rem; }
  .card .em { font-size: 3rem; }
  .card .name { font-weight:600; margin: 0.5rem 0 0.25rem; }
  .card .price { color:#a78bfa; font-size: 1.15rem; }
  .btn { background:#fff; color:#000; border:none; border-radius:0.5rem; padding:0.7rem 1.2rem; font-weight:600; cursor:pointer; font-family:inherit; }
  .btn:hover { opacity: 0.9; }
  .btn.full { width:100%; padding: 0.85rem; margin-top: 1rem; font-size: 1rem; }
  .btn.ghost { background:transparent; color:#eaeaea; border:1px solid #333; }
  table { width:100%; border-collapse: collapse; margin-top: 1.25rem; }
  th, td { padding: 0.75rem 0.5rem; text-align: left; border-bottom: 1px solid #222; }
  th { color: #888; font-weight: 500; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; }
  input[type=number], input[type=text], input[type=email] {
    background:#1a1a1c; border:1px solid #333; color:#eaeaea; padding:0.6rem 0.8rem;
    border-radius:0.4rem; font-family:inherit; font-size:0.95rem; width: 100%;
  }
  input[type=number] { width: 5rem; text-align: center; }
  label { display:block; font-size: 0.85rem; color:#aaa; margin: 1rem 0 0.35rem; }
  .total { font-size: 1.5rem; font-weight: 700; text-align: right; margin-top: 1.25rem; color: #fff; }
  .success-card { background:#141415; border:1px solid #22c55e; border-radius: 0.75rem; padding:2rem; text-align:center; }
  .success-card h1 { color:#22c55e; }
  .muted { color:#777; font-size: 0.9rem; }
  .fork-banner { position:fixed; top:0; left:0; right:0; z-index:9999; padding:0.7rem 1rem;
    background:${bannerColor ?? '#111'}; color:#fff; font-weight:700; text-align:center;
    box-shadow:0 6px 24px rgba(0,0,0,0.5); letter-spacing: 0.02em; }
</style>
</head><body>`
}

const nav = (cartCount = 0) => `
  <div class="nav">
    <div class="logo">◆ Shop <span>Swarm</span></div>
    <div>
      <a href="/">Shop</a>
      <a href="/cart">Cart</a>
      <a href="/checkout">Checkout</a>
      <span class="cart-chip" id="cart-chip">${cartCount} in cart</span>
    </div>
  </div>`

const cartSyncScript = `
  <script>
    const cart = () => JSON.parse(localStorage.getItem('cart') || '[]');
    const setCart = (c) => localStorage.setItem('cart', JSON.stringify(c));
    const cartCount = () => cart().reduce((n,i) => n + (parseInt(i.qty)||1), 0);
    const refresh = () => { const el = document.getElementById('cart-chip'); if (el) el.textContent = cartCount() + ' in cart'; };
    refresh();
  </script>`

const homePage = () => baseHead('Shop') + nav() + `
  <div class="page">
    <h1>Featured products</h1>
    <p class="muted">Powered by the world's most fragile e-commerce stack. Be gentle.</p>
    <div class="products">
      ${PRODUCTS.map((p) => `
        <div class="card">
          <div class="em">${p.emoji}</div>
          <div class="name">${p.name}</div>
          <div class="price">$${p.price}</div>
          <button class="btn full" data-sku="${p.sku}">Add to cart</button>
        </div>`).join('')}
    </div>
  </div>
  ${cartSyncScript}
  <script>
    document.querySelectorAll('button[data-sku]').forEach(b => {
      b.addEventListener('click', () => {
        const sku = b.dataset.sku;
        const p = ${JSON.stringify(PRODUCTS)}.find(x => x.sku === sku);
        const c = cart();
        const ex = c.find(i => i.sku === sku);
        if (ex) ex.qty = (parseInt(ex.qty)||1) + 1;
        else c.push({ sku, price: p.price, qty: 1 });
        setCart(c);
        refresh();
      });
    });
  </script>
  </body></html>`

const cartPage = () => baseHead('Cart') + nav() + `
  <div class="page">
    <h1>Your cart</h1>
    <div id="cart-container"></div>
    <div class="total" id="total">Total: $0</div>
    <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem">
      <a href="/" class="btn ghost">Keep shopping</a>
      <a href="/checkout" class="btn" id="checkout-link">Proceed to checkout</a>
    </div>
  </div>
  ${cartSyncScript}
  <script>
    const PRODUCTS = ${JSON.stringify(PRODUCTS)};
    function render() {
      const c = cart();
      const html = c.length === 0 ? '<p class="muted">Your cart is empty.</p>' :
        '<table><thead><tr><th>Item</th><th>Qty</th><th>Line total</th><th></th></tr></thead><tbody>' +
        c.map((i, idx) => {
          const p = PRODUCTS.find(x => x.sku === i.sku);
          const lineTotal = (parseFloat(i.price) || 0) * (parseFloat(i.qty) || 0);
          return '<tr>' +
            '<td>' + (p ? p.emoji + ' ' + p.name : i.sku) + '</td>' +
            '<td><input type="number" data-idx="' + idx + '" value="' + i.qty + '" /></td>' +
            '<td>$' + lineTotal + '</td>' +
            '<td><button class="btn ghost" data-remove="' + idx + '">Remove</button></td>' +
            '</tr>';
        }).join('') +
        '</tbody></table>';
      document.getElementById('cart-container').innerHTML = html;
      const total = c.reduce((s,i) => s + (parseFloat(i.price) || 0) * (parseFloat(i.qty) || 0), 0);
      document.getElementById('total').textContent = 'Total: $' + total;
      document.querySelectorAll('input[data-idx]').forEach(inp => {
        inp.addEventListener('input', () => {
          const idx = parseInt(inp.dataset.idx);
          const c2 = cart();
          c2[idx].qty = inp.value; /* BUG: no validation, accepts any string/number */
          setCart(c2); render(); refresh();
        });
      });
      document.querySelectorAll('button[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.remove);
          const c2 = cart(); c2.splice(idx,1); setCart(c2); render(); refresh();
        });
      });
    }
    render();
  </script>
  </body></html>`

const checkoutPage = () => baseHead('Checkout') + nav() + `
  <div class="page">
    <h1>Checkout</h1>
    <div id="summary" class="muted"></div>
    <label for="email">Email address</label>
    <input id="email" type="email" placeholder="you@example.com" />
    <label for="name">Name on card</label>
    <input id="name" type="text" placeholder="Jane Doe" />
    <label for="card">Card number</label>
    <input id="card" type="text" placeholder="4242 4242 4242 4242" />
    <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1.5rem">
      <button id="place" class="btn">Place order</button>
    </div>
    <pre id="log" style="background:#1a1a1c;border:1px solid #222;padding:1rem;border-radius:0.5rem;margin-top:1.25rem;min-height:3rem;color:#888;font-size:0.85rem"></pre>
  </div>
  ${cartSyncScript}
  <script>
    const items = cart();
    document.getElementById('summary').textContent = items.length + ' item(s) · total $' +
      items.reduce((s,i) => s + (parseFloat(i.price)||0)*(parseFloat(i.qty)||0), 0);
    document.getElementById('place').addEventListener('click', async () => {
      const body = {
        items,
        email: document.getElementById('email').value,
        name: document.getElementById('name').value,
        card: document.getElementById('card').value,
      };
      const r = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      const log = document.getElementById('log');
      log.textContent += 'HTTP ' + r.status + ' ' + JSON.stringify(data) + '\\n';
      if (r.ok && data.orderId) {
        setCart([]);
        setTimeout(() => location.href = '/success?order=' + data.orderId + '&name=' + encodeURIComponent(body.name), 500);
      }
    });
  </script>
  </body></html>`

const successPage = (name: string, orderId: string) => baseHead('Success') + nav() + `
  <div class="page">
    <div class="success-card">
      <h1>✓ Order complete</h1>
      <p class="muted">Order ID</p>
      <code style="color:#a78bfa">${orderId}</code>
      <p style="margin-top:2rem">Thanks, <span id="nm"></span>!</p>
      <p class="muted">Receipt has been emailed.</p>
    </div>
  </div>
  <script>
    /* BUG: innerHTML with user-supplied name from query string — XSS reflection */
    const qs = new URLSearchParams(location.search);
    const nm = qs.get('name') || 'friend';
    document.getElementById('nm').innerHTML = nm;
  </script>
  </body></html>`

function cookieFromReq(req: http.IncomingMessage): string | undefined {
  return req.headers.cookie?.match(/sid=([^;]+)/)?.[1]
}
async function parseBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c)
  const str = Buffer.concat(chunks).toString('utf8')
  try { return str ? JSON.parse(str) : {} } catch { return {} }
}

export async function startBuggyServer(port = 0): Promise<{
  url: string; port: number; stop: () => Promise<void>; sessions: Map<string, Session>
}> {
  const sessions = new Map<string, Session>()
  let counter = 0

  const server = http.createServer(async (req, res) => {
    let sid = cookieFromReq(req)
    if (!sid) {
      sid = `s${++counter}`
      res.setHeader('Set-Cookie', `sid=${sid}; Path=/; SameSite=Lax`)
    }
    if (!sessions.has(sid)) sessions.set(sid, { sid, orders: [] })
    const session = sessions.get(sid)!

    const url = req.url ?? '/'

    if (req.method === 'GET' && url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(homePage())
      return
    }
    if (req.method === 'GET' && url === '/cart') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(cartPage())
      return
    }
    if (req.method === 'GET' && url === '/checkout') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(checkoutPage())
      return
    }
    if (req.method === 'GET' && url.startsWith('/success')) {
      const u = new URL(url, 'http://local')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(successPage(u.searchParams.get('name') ?? 'friend', u.searchParams.get('order') ?? '???'))
      return
    }

    if (req.method === 'POST' && url === '/api/checkout') {
      const body = await parseBody(req)
      const items: CartItem[] = Array.isArray(body.items) ? body.items : []
      if (items.length === 0) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'empty cart' }))
        return
      }
      // BUG: email is not validated on the server. The code below tries to
      // parse the email domain; for empty / malformed input this crashes → 500.
      try {
        const _domain = body.email.split('@')[1].toLowerCase() // crashes on '' or missing '@'
        void _domain
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'server error', detail: e?.message ?? 'unknown' }))
        return
      }

      // BUG: no idempotency key — concurrent POSTs create duplicate orders.
      await new Promise((r) => setTimeout(r, 60))
      const total = items.reduce(
        (s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 0),
        0
      )
      const order: Order = {
        orderId: randomUUID(),
        sid,
        items,
        email: body.email,
        name: body.name ?? '',
        total,
        at: Date.now(),
      }
      session.orders.push(order)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, orderId: order.orderId }))
      return
    }

    if (req.method === 'GET' && url.startsWith('/api/orders')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ sid, orders: session.orders }))
      return
    }

    res.statusCode = 404
    res.end('not found')
  })

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        stop: () => new Promise<void>((r) => server.close(() => r())),
        sessions,
      })
    })
    server.on('error', reject)
  })
}
