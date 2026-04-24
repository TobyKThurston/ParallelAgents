/**
 * "Helix" — a deliberately-buggy multi-page SaaS app served as plain HTML.
 *
 * Modeled loosely on Linear/Notion. Acts as the target the adversarial fork
 * swarm tests. Multiple flows, multiple bug categories, varied attack surface.
 *
 * Pages:
 *   /                       Dashboard (stats, recent activity)
 *   /issues                 Issue list + "new issue" CTA
 *   /issues/new             Create form (title, description, priority, assignee)
 *   /billing                Plan upgrade form (seats, coupon, card, email, name)
 *   /billing/success?...    Order confirmation (XSS via innerHTML on name)
 *   /settings               Profile (display name, avatar URL — javascript: URLs unfiltered)
 *
 * Planted bugs (intentional):
 *   [I1] POST /api/issues — no idempotency → concurrent submits create dupes
 *   [I2] Issue list renders titles via innerHTML → XSS
 *   [I3] POST /api/issues — server crashes on empty title (.toUpperCase() on undefined)
 *   [B1] /billing seats input has no min → negative seats → negative total
 *   [B2] Coupon code "FREE100" applies 100% off → total may go to 0 or negative
 *   [B3] POST /api/billing — concurrent submits create duplicate orders
 *   [B4] POST /api/billing — missing email crashes (.split('@')[1].toLowerCase())
 *   [B5] /billing/success renders ?name= via innerHTML → XSS
 *   [S1] /settings avatar URL accepts `javascript:` schemes (rendered as <img src>)
 *
 * Cart-style state remains for backward compat with old fork-runner code paths.
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'

type Order = { orderId: string; sid: string; email: string; name: string; total: number; at: number }
type Issue = { id: string; title: string; description: string; priority: string; assignee: string; at: number }
type Session = { sid: string; orders: Order[]; issues: Issue[]; profileName: string; avatarUrl: string }

const SHELL_HEAD = (title: string) => `<!doctype html>
<html><head>
<meta charset="utf-8" />
<title>${title} — Helix</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='80' font-size='80'%3E%E2%97%86%3C/text%3E%3C/svg%3E" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: #0b0b0e; color: #ededee; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; font-size: 14px; }
  a { color: inherit; text-decoration: none; }
  button { font-family: inherit; cursor: pointer; }
  code, kbd, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.92em; }
  .app { display: grid; grid-template-columns: 232px 1fr; grid-template-rows: 100vh; min-height: 100vh; }
  /* SIDEBAR */
  .side { background: #0e0e12; border-right: 1px solid #1c1c22; padding: 14px 10px; display: flex; flex-direction: column; gap: 18px; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 6px 8px 12px; border-bottom: 1px solid #1c1c22; }
  .brand-logo { width: 26px; height: 26px; border-radius: 7px; background: linear-gradient(135deg, #a78bfa, #6d28d9); display: grid; place-items: center; font-weight: 700; color: #fff; box-shadow: 0 6px 18px rgba(139,92,246,0.35); }
  .brand-name { font-weight: 600; letter-spacing: -0.01em; }
  .brand-sub { font-size: 11px; color: #6a6a72; }
  .nav-group { display: flex; flex-direction: column; gap: 1px; }
  .nav-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: #6a6a72; padding: 8px 10px 4px; }
  .nav a { display: flex; align-items: center; gap: 9px; padding: 6px 10px; border-radius: 6px; color: #c9c9cc; font-size: 13px; }
  .nav a:hover { background: #16161b; color: #fff; }
  .nav a.active { background: #1d1d24; color: #fff; }
  .nav a .ic { width: 14px; height: 14px; opacity: 0.85; flex-shrink: 0; }
  .nav-count { margin-left: auto; font-size: 11px; color: #6a6a72; font-family: ui-monospace, monospace; }
  .side-bottom { margin-top: auto; padding: 10px; border-top: 1px solid #1c1c22; display: flex; gap: 9px; align-items: center; }
  .avatar { width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg, #a78bfa, #4c1d95); display: grid; place-items: center; font-size: 11px; color: #fff; font-weight: 600; flex-shrink: 0; overflow: hidden; }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  .who { font-size: 12px; line-height: 1.2; }
  .who .nm { font-weight: 500; }
  .who .em { color: #6a6a72; font-size: 11px; }
  /* MAIN */
  main { overflow: auto; min-width: 0; }
  .top { display: flex; align-items: center; justify-content: space-between; padding: 14px 28px; border-bottom: 1px solid #1c1c22; background: #0b0b0e; position: sticky; top: 0; z-index: 5; }
  .crumbs { font-size: 13px; color: #909094; display: flex; align-items: center; gap: 8px; }
  .crumbs strong { color: #ededee; font-weight: 500; }
  .crumbs .sep { color: #4a4a52; }
  .top-actions { display: flex; gap: 8px; align-items: center; }
  .iconbtn { width: 30px; height: 30px; border-radius: 6px; border: 1px solid #25252c; background: #15151a; color: #909094; display: grid; place-items: center; font-size: 13px; }
  .page { padding: 28px 32px 80px; max-width: 1100px; }
  h1.title { font-size: 22px; letter-spacing: -0.02em; margin: 0 0 6px; font-weight: 600; }
  .lede { color: #909094; font-size: 13px; margin: 0 0 22px; }
  /* CARDS */
  .card { background: #14141a; border: 1px solid #22222a; border-radius: 8px; }
  .card .hdr { padding: 12px 16px; border-bottom: 1px solid #22222a; display: flex; align-items: center; justify-content: space-between; }
  .card .hdr h3 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: -0.005em; }
  .card .body { padding: 16px; }
  /* GRID */
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .stat { background: #14141a; border: 1px solid #22222a; border-radius: 8px; padding: 14px 16px; }
  .stat .lbl { font-size: 11px; color: #6a6a72; text-transform: uppercase; letter-spacing: 0.06em; }
  .stat .val { font-size: 22px; font-weight: 600; margin-top: 4px; letter-spacing: -0.02em; }
  .stat .delta { font-size: 11px; color: #7ddc9c; margin-top: 2px; }
  .stat .delta.down { color: #ff6b6b; }
  /* FORMS */
  label.fld { display: block; margin-bottom: 14px; }
  label.fld .lbl { display: block; font-size: 12px; color: #c9c9cc; margin-bottom: 6px; font-weight: 500; }
  label.fld .help { display: block; font-size: 11px; color: #6a6a72; margin-top: 4px; }
  input[type=text], input[type=email], input[type=number], input[type=url], textarea, select {
    width: 100%; background: #0c0c10; border: 1px solid #25252c; color: #ededee; padding: 9px 11px; border-radius: 6px; font-family: inherit; font-size: 13px; outline: none; transition: border-color 0.12s ease, background 0.12s ease;
  }
  input:focus, textarea:focus, select:focus { border-color: #6d28d9; background: #0e0e14; }
  textarea { min-height: 90px; resize: vertical; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  /* BUTTONS */
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 6px; font-weight: 500; font-size: 13px; border: 1px solid transparent; transition: background 0.12s ease, border-color 0.12s ease; }
  .btn.primary { background: #7c3aed; color: #fff; }
  .btn.primary:hover { background: #6d28d9; }
  .btn.ghost { background: transparent; border-color: #2a2a31; color: #ededee; }
  .btn.ghost:hover { background: #16161b; }
  .btn.danger { background: #2a0e0e; border-color: #7f1d1d; color: #ffb4b4; }
  /* TABLE */
  table.list { width: 100%; border-collapse: collapse; }
  table.list th, table.list td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #1c1c22; font-size: 13px; }
  table.list th { font-size: 11px; font-weight: 500; color: #6a6a72; text-transform: uppercase; letter-spacing: 0.06em; background: #0e0e12; }
  table.list tr:hover td { background: #11111a; }
  .pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; line-height: 1.5; }
  .pill.high { background: #2a0e0e; color: #ff6b6b; }
  .pill.med { background: #2a230e; color: #fbbf24; }
  .pill.low { background: #11242c; color: #7aa7ff; }
  .pill.todo { background: #1c1c22; color: #c9c9cc; }
  .empty { text-align: center; padding: 60px 16px; color: #6a6a72; }
  .empty h4 { color: #ededee; font-size: 14px; margin: 0 0 6px; }
  /* MISC */
  hr.div { border: 0; border-top: 1px solid #22222a; margin: 18px 0; }
  .receipt { background: #0c0c10; border: 1px solid #22222a; border-radius: 6px; padding: 12px 14px; margin-top: 14px; }
  .receipt-line { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; color: #c9c9cc; }
  .receipt-line.total { border-top: 1px solid #22222a; padding-top: 8px; margin-top: 4px; font-weight: 600; color: #ededee; }
  .badge { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 3px; background: #1d1d24; color: #c9c9cc; font-size: 11px; font-family: ui-monospace, monospace; }
  .alert { padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 14px; }
  .alert.success { background: #0d1f14; border: 1px solid #166534; color: #7ddc9c; }
  .alert.error { background: #2a0e0e; border: 1px solid #7f1d1d; color: #ffb4b4; }
  /* SUCCESS PAGE */
  .success-card { max-width: 540px; margin: 60px auto; background: #14141a; border: 1px solid #22222a; border-radius: 12px; padding: 36px; text-align: center; }
  .success-card .check { width: 56px; height: 56px; border-radius: 50%; background: #166534; display: grid; place-items: center; margin: 0 auto 18px; color: #7ddc9c; font-size: 24px; }
</style>
</head><body>`

const sidebar = (active: string, issueCount: number) => `
<aside class="side">
  <div class="brand">
    <div class="brand-logo">◆</div>
    <div>
      <div class="brand-name">Helix</div>
      <div class="brand-sub">Acme Corp · Pro</div>
    </div>
  </div>
  <div class="nav-group nav">
    <div class="nav-label">Workspace</div>
    <a class="${active === 'dashboard' ? 'active' : ''}" href="/"><span class="ic">▦</span> Dashboard</a>
    <a class="${active === 'issues' ? 'active' : ''}" href="/issues"><span class="ic">◇</span> Issues<span class="nav-count">${issueCount}</span></a>
    <a class=""  href="/issues"><span class="ic">⊙</span> Active</a>
    <a class=""  href="/issues"><span class="ic">⚐</span> Backlog</a>
  </div>
  <div class="nav-group nav">
    <div class="nav-label">Workspaces</div>
    <a href="/issues"><span class="ic">●</span> Engineering</a>
    <a href="/issues"><span class="ic">●</span> Marketing</a>
    <a href="/issues"><span class="ic">●</span> Design</a>
  </div>
  <div class="nav-group nav">
    <div class="nav-label">Settings</div>
    <a class="${active === 'settings' ? 'active' : ''}" href="/settings"><span class="ic">◔</span> Profile</a>
    <a class="${active === 'billing' ? 'active' : ''}" href="/billing"><span class="ic">⌗</span> Billing</a>
  </div>
  <div class="side-bottom">
    <div class="avatar" id="user-avatar">TH</div>
    <div class="who">
      <div class="nm" id="user-name">Toby H.</div>
      <div class="em">toby@acme.com</div>
    </div>
  </div>
</aside>`

const topbar = (crumbs: string, actions = '') => `
<header class="top">
  <div class="crumbs">${crumbs}</div>
  <div class="top-actions">${actions}<div class="iconbtn">⌥</div><div class="iconbtn">?</div></div>
</header>`

const dashboardPage = (issueCount: number, profileName: string) => SHELL_HEAD('Dashboard') + `
<div class="app">
  ${sidebar('dashboard', issueCount)}
  <main>
    ${topbar('<strong>Dashboard</strong>')}
    <div class="page">
      <h1 class="title">Welcome back, <span id="greet"></span></h1>
      <p class="lede">Here&rsquo;s what&rsquo;s happening across your workspace.</p>

      <div class="stats">
        <div class="stat"><div class="lbl">Active issues</div><div class="val">${issueCount}</div><div class="delta">+3 this week</div></div>
        <div class="stat"><div class="lbl">Resolved</div><div class="val">128</div><div class="delta">+12% MoM</div></div>
        <div class="stat"><div class="lbl">Avg cycle</div><div class="val">2.4d</div><div class="delta down">+0.3d</div></div>
        <div class="stat"><div class="lbl">Throughput</div><div class="val">87%</div><div class="delta">+4%</div></div>
      </div>

      <div class="card">
        <div class="hdr"><h3>Recent activity</h3><a class="btn ghost" href="/issues">View all →</a></div>
        <div class="body">
          <div class="receipt-line"><span>HEL-128 · API gateway throttling</span><span class="badge">in progress</span></div>
          <div class="receipt-line"><span>HEL-127 · Stripe retries on 5xx</span><span class="badge">review</span></div>
          <div class="receipt-line"><span>HEL-126 · Migrate to TanStack Query</span><span class="badge">done</span></div>
          <div class="receipt-line"><span>HEL-125 · Mobile nav drawer</span><span class="badge">done</span></div>
        </div>
      </div>
    </div>
  </main>
</div>
<script>
  // BUG S2: greet name via innerHTML — XSS reflection from profile state
  const profileName = ${JSON.stringify(profileName)};
  document.getElementById('greet').innerHTML = profileName;
</script>
</body></html>`

const issuesListPage = (issueCount: number) => SHELL_HEAD('Issues') + `
<div class="app">
  ${sidebar('issues', issueCount)}
  <main>
    ${topbar(
      '<a href="/">Dashboard</a><span class="sep">/</span><strong>Issues</strong>',
      '<a class="btn primary" href="/issues/new">+ New issue</a>'
    )}
    <div class="page">
      <h1 class="title">Issues</h1>
      <p class="lede">Track and triage work across the workspace.</p>
      <div class="card">
        <div class="hdr">
          <h3>All issues</h3>
          <span class="badge"><span id="count-badge">0</span> total</span>
        </div>
        <div class="body" style="padding: 0">
          <table class="list">
            <thead><tr><th style="width: 80px">ID</th><th>Title</th><th style="width: 120px">Priority</th><th style="width: 140px">Assignee</th><th style="width: 100px">Status</th></tr></thead>
            <tbody id="issues-tbody"><tr><td colspan="5" class="empty"><h4>No issues yet</h4><div>Create your first issue to get started.</div></td></tr></tbody>
          </table>
        </div>
      </div>
    </div>
  </main>
</div>
<script>
  async function load() {
    const r = await fetch('/api/issues');
    const data = await r.json();
    const tbody = document.getElementById('issues-tbody');
    document.getElementById('count-badge').textContent = (data.issues || []).length;
    if (!data.issues || data.issues.length === 0) {
      return; // keep the empty state
    }
    // BUG I2: titles rendered via innerHTML — XSS via stored payload
    tbody.innerHTML = data.issues.map(i =>
      '<tr><td><span class="badge">' + i.id + '</span></td>' +
      '<td>' + i.title + '</td>' +  // <-- vulnerable
      '<td><span class="pill ' + (i.priority || 'low') + '">' + (i.priority || 'low') + '</span></td>' +
      '<td>' + (i.assignee || '—') + '</td>' +
      '<td><span class="pill todo">open</span></td></tr>'
    ).join('');
  }
  load();
</script>
</body></html>`

const issuesNewPage = (issueCount: number) => SHELL_HEAD('New issue') + `
<div class="app">
  ${sidebar('issues', issueCount)}
  <main>
    ${topbar(
      '<a href="/">Dashboard</a><span class="sep">/</span><a href="/issues">Issues</a><span class="sep">/</span><strong>New</strong>'
    )}
    <div class="page" style="max-width: 720px">
      <h1 class="title">New issue</h1>
      <p class="lede">Create a tracked issue. Required fields are marked with an asterisk.</p>
      <div id="alert-slot"></div>
      <div class="card">
        <div class="body">
          <label class="fld"><span class="lbl">Title *</span>
            <input id="title" type="text" placeholder="Implement retries on 5xx" />
          </label>
          <label class="fld"><span class="lbl">Description</span>
            <textarea id="description" placeholder="What needs to happen?"></textarea>
          </label>
          <div class="row">
            <label class="fld"><span class="lbl">Priority</span>
              <select id="priority"><option value="low">Low</option><option value="med">Medium</option><option value="high">High</option></select>
            </label>
            <label class="fld"><span class="lbl">Assignee</span>
              <input id="assignee" type="text" placeholder="@username" />
            </label>
          </div>
          <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px">
            <a class="btn ghost" href="/issues">Cancel</a>
            <button id="create" class="btn primary">Create issue</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</div>
<script>
  document.getElementById('create').addEventListener('click', async () => {
    const body = {
      title: document.getElementById('title').value,
      description: document.getElementById('description').value,
      priority: document.getElementById('priority').value,
      assignee: document.getElementById('assignee').value,
    };
    const r = await fetch('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    const slot = document.getElementById('alert-slot');
    if (r.ok) {
      slot.innerHTML = '<div class="alert success">Created ' + data.id + '. Redirecting…</div>';
      setTimeout(() => location.href = '/issues', 700);
    } else {
      slot.innerHTML = '<div class="alert error">HTTP ' + r.status + ': ' + (data.error || 'unknown') + '</div>';
    }
  });
</script>
</body></html>`

const billingPage = (issueCount: number) => SHELL_HEAD('Billing') + `
<div class="app">
  ${sidebar('billing', issueCount)}
  <main>
    ${topbar('<a href="/">Dashboard</a><span class="sep">/</span><strong>Billing</strong>')}
    <div class="page" style="max-width: 720px">
      <h1 class="title">Upgrade plan</h1>
      <p class="lede">Move your workspace to <strong style="color: #a78bfa">Helix Business</strong> for unlimited issues + SSO.</p>
      <div id="alert-slot"></div>
      <div class="card">
        <div class="body">
          <div class="row">
            <label class="fld"><span class="lbl">Seats</span>
              <input id="seats" type="number" value="5" />
              <span class="help">$10 per seat / month</span>
            </label>
            <label class="fld"><span class="lbl">Coupon code</span>
              <input id="coupon" type="text" placeholder="optional" />
              <span class="help">Have one? Apply for a discount.</span>
            </label>
          </div>
          <hr class="div" />
          <div class="row">
            <label class="fld"><span class="lbl">Email *</span>
              <input id="email" type="email" placeholder="billing@acme.com" />
            </label>
            <label class="fld"><span class="lbl">Cardholder name *</span>
              <input id="name" type="text" placeholder="A. Person" />
            </label>
          </div>
          <label class="fld"><span class="lbl">Card number *</span>
            <input id="card" type="text" placeholder="4242 4242 4242 4242" />
          </label>

          <div class="receipt">
            <div class="receipt-line"><span>Helix Business · <span id="seat-count">5</span> seats</span><span>$<span id="subtotal">50</span>/mo</span></div>
            <div class="receipt-line"><span>Discount (<span id="coupon-applied">none</span>)</span><span>-$<span id="discount">0</span></span></div>
            <div class="receipt-line total"><span>Total today</span><span>$<span id="total">50</span></span></div>
          </div>

          <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px">
            <a class="btn ghost" href="/">Cancel</a>
            <button id="place" class="btn primary">Pay $<span id="btn-total">50</span></button>
          </div>
        </div>
      </div>
    </div>
  </main>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  function recalc() {
    const seats = parseFloat($('seats').value);  // BUG B1: no min check, accepts negatives
    const subtotal = seats * 10;
    const couponRaw = $('coupon').value.trim().toUpperCase();
    let discount = 0;
    let applied = 'none';
    // BUG B2: FREE100 is a real coupon code with no max-discount cap
    if (couponRaw === 'FREE100') { discount = subtotal; applied = 'FREE100 (-100%)'; }
    else if (couponRaw === 'SAVE10') { discount = subtotal * 0.10; applied = 'SAVE10 (-10%)'; }
    const total = subtotal - discount;
    $('seat-count').textContent = seats;
    $('subtotal').textContent = subtotal;
    $('discount').textContent = discount;
    $('coupon-applied').textContent = applied;
    $('total').textContent = total;
    $('btn-total').textContent = total;
  }
  $('seats').addEventListener('input', recalc);
  $('coupon').addEventListener('input', recalc);
  recalc();
  $('place').addEventListener('click', async () => {
    const body = {
      seats: parseFloat($('seats').value),
      coupon: $('coupon').value,
      email: $('email').value,
      name: $('name').value,
      card: $('card').value,
    };
    const r = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    const slot = $('alert-slot');
    if (r.ok && data.orderId) {
      slot.innerHTML = '<div class="alert success">Payment received. Order ' + data.orderId + '. Redirecting…</div>';
      setTimeout(() => location.href = '/billing/success?order=' + data.orderId + '&name=' + encodeURIComponent(body.name), 600);
    } else {
      slot.innerHTML = '<div class="alert error">HTTP ' + r.status + ': ' + (data.error || 'unknown') + '</div>';
    }
  });
</script>
</body></html>`

const billingSuccessPage = (orderId: string, name: string, issueCount: number) => SHELL_HEAD('Order confirmed') + `
<div class="app">
  ${sidebar('billing', issueCount)}
  <main>
    ${topbar('<a href="/">Dashboard</a><span class="sep">/</span><a href="/billing">Billing</a><span class="sep">/</span><strong>Confirmed</strong>')}
    <div class="success-card">
      <div class="check">✓</div>
      <h1 class="title" style="font-size: 18px">Order confirmed</h1>
      <p class="lede">Order ID</p>
      <div class="badge" style="font-size: 13px">${orderId}</div>
      <p style="margin-top: 24px; color: #c9c9cc">Thanks, <span id="thanks-name"></span>! A receipt has been sent to your email.</p>
    </div>
  </main>
</div>
<script>
  // BUG B5: name from query string rendered via innerHTML — XSS reflection
  const qs = new URLSearchParams(location.search);
  const nm = qs.get('name') || 'friend';
  document.getElementById('thanks-name').innerHTML = nm;
</script>
</body></html>`

const settingsPage = (issueCount: number, profileName: string, avatarUrl: string) => SHELL_HEAD('Settings') + `
<div class="app">
  ${sidebar('settings', issueCount)}
  <main>
    ${topbar('<a href="/">Dashboard</a><span class="sep">/</span><strong>Profile</strong>')}
    <div class="page" style="max-width: 720px">
      <h1 class="title">Profile</h1>
      <p class="lede">Personalize your account.</p>
      <div id="alert-slot"></div>
      <div class="card">
        <div class="body">
          <div style="display: flex; gap: 16px; align-items: center; margin-bottom: 18px">
            <div class="avatar" style="width: 64px; height: 64px; border-radius: 12px; font-size: 18px">
              <img id="avatar-preview" src="${avatarUrl || ''}" alt="" onerror="this.replaceWith(document.createTextNode('?'))" />
            </div>
            <div>
              <div style="font-weight: 600">${profileName}</div>
              <div style="font-size: 12px; color: #6a6a72">toby@acme.com · Pro plan</div>
            </div>
          </div>
          <label class="fld"><span class="lbl">Display name</span>
            <input id="name" type="text" value="${profileName.replace(/"/g, '&quot;')}" />
          </label>
          <label class="fld"><span class="lbl">Avatar URL</span>
            <input id="avatar" type="url" value="${avatarUrl.replace(/"/g, '&quot;')}" placeholder="https://example.com/me.jpg" />
            <span class="help">Paste a URL to an image. <!-- BUG S1: javascript: schemes accepted --></span>
          </label>
          <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px">
            <button id="save" class="btn primary">Save changes</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</div>
<script>
  document.getElementById('save').addEventListener('click', async () => {
    const body = {
      name: document.getElementById('name').value,
      avatar: document.getElementById('avatar').value,
    };
    const r = await fetch('/api/profile', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body) });
    const data = await r.json();
    const slot = document.getElementById('alert-slot');
    if (r.ok) {
      slot.innerHTML = '<div class="alert success">Profile saved.</div>';
      setTimeout(() => location.reload(), 500);
    } else {
      slot.innerHTML = '<div class="alert error">' + (data.error || 'failed') + '</div>';
    }
  });
</script>
</body></html>`

// ---------- Server ----------

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
  url: string
  port: number
  stop: () => Promise<void>
  sessions: Map<string, Session>
}> {
  const sessions = new Map<string, Session>()
  let counter = 0

  const server = http.createServer(async (req, res) => {
    let sid = cookieFromReq(req)
    if (!sid) {
      sid = `s${++counter}`
      res.setHeader('Set-Cookie', `sid=${sid}; Path=/; SameSite=Lax`)
    }
    if (!sessions.has(sid)) {
      sessions.set(sid, {
        sid,
        orders: [],
        issues: [],
        profileName: 'Toby Thurston',
        avatarUrl: '',
      })
    }
    const session = sessions.get(sid)!
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    // ---------- Pages ----------

    if (method === 'GET' && url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(dashboardPage(session.issues.length, session.profileName))
      return
    }
    if (method === 'GET' && url === '/issues') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(issuesListPage(session.issues.length))
      return
    }
    if (method === 'GET' && url === '/issues/new') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(issuesNewPage(session.issues.length))
      return
    }
    if (method === 'GET' && url === '/billing') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(billingPage(session.issues.length))
      return
    }
    if (method === 'GET' && url.startsWith('/billing/success')) {
      const u = new URL(url, 'http://local')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(
        billingSuccessPage(
          u.searchParams.get('order') ?? '???',
          u.searchParams.get('name') ?? 'friend',
          session.issues.length
        )
      )
      return
    }
    if (method === 'GET' && url === '/settings') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(settingsPage(session.issues.length, session.profileName, session.avatarUrl))
      return
    }

    // ---------- API: issues ----------

    if (method === 'GET' && url === '/api/issues') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ issues: session.issues }))
      return
    }

    if (method === 'POST' && url === '/api/issues') {
      const body = await parseBody(req)
      // BUG I3: server crashes on empty/missing title — derives an avatar
      // initial from title.trim()[0], which throws on '' or undefined.
      try {
        if (!body.title || typeof body.title !== 'string' || body.title.trim() === '') {
          // Boom: dereferencing [0] on undefined when split is empty
          // (simulating a careless avatar-letter computation)
          throw new (body.title as any)[0].constructor('title required')
        }
        const _initial = body.title.trim().toUpperCase().slice(0, 1)
        void _initial
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'server error', detail: e?.message ?? 'unknown' }))
        return
      }
      // BUG I1: no idempotency key — concurrent posts create duplicates
      await new Promise((r) => setTimeout(r, 60))
      const id = `HEL-${100 + session.issues.length + 1}`
      const issue: Issue = {
        id,
        title: String(body.title ?? ''),
        description: String(body.description ?? ''),
        priority: ['low', 'med', 'high'].includes(body.priority) ? body.priority : 'low',
        assignee: String(body.assignee ?? ''),
        at: Date.now(),
      }
      session.issues.push(issue)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, id }))
      return
    }

    // ---------- API: billing ----------

    if (method === 'POST' && url === '/api/billing/checkout') {
      const body = await parseBody(req)
      // BUG B4: missing email crashes the email-domain parser
      try {
        const _domain = body.email.split('@')[1].toLowerCase()
        void _domain
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'server error', detail: e?.message ?? 'unknown' }))
        return
      }
      const seats = Number(body.seats) || 0
      let discount = 0
      const coupon = String(body.coupon ?? '').trim().toUpperCase()
      if (coupon === 'FREE100') discount = seats * 10 // BUG B2 server-side enforcement is the same broken logic
      else if (coupon === 'SAVE10') discount = seats * 10 * 0.1
      const total = seats * 10 - discount
      // BUG B3: no idempotency
      await new Promise((r) => setTimeout(r, 60))
      const order: Order = {
        orderId: randomUUID(),
        sid,
        email: body.email,
        name: body.name ?? '',
        total,
        at: Date.now(),
      }
      session.orders.push(order)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, orderId: order.orderId, total }))
      return
    }

    if (method === 'GET' && url.startsWith('/api/orders')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ sid, orders: session.orders }))
      return
    }

    // ---------- API: profile ----------

    if (method === 'POST' && url === '/api/profile') {
      const body = await parseBody(req)
      session.profileName = String(body.name ?? session.profileName)
      // BUG S1: avatar URL accepted as-is, no scheme check (javascript:, data: pass)
      session.avatarUrl = String(body.avatar ?? '')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
      return
    }

    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain')
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
