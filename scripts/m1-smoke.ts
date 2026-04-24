/**
 * M1 smoke test — retire the three risks that could kill the architecture:
 *   1. Vercel Sandbox auth works from a local script.
 *   2. A process running inside the sandbox is reachable on a public URL.
 *   3. Playwright from our orchestrator can drive that URL end-to-end.
 *
 * Run:  pnpm run m1:smoke
 * Pre:  vercel link && vercel env pull   (drops VERCEL_OIDC_TOKEN into .env.local)
 */

import { Sandbox } from '@vercel/sandbox'
import { chromium } from 'playwright'
import { config as loadEnv } from 'dotenv'
import { mkdir, writeFile } from 'node:fs/promises'
import ms from 'ms'

loadEnv({ path: '.env.local' })

const SERVER_JS = `
const http = require('http');
const PORT = 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    '<!doctype html>' +
    '<html><head><title>M1</title></head>' +
    '<body style="font-family:system-ui;padding:2rem">' +
    '<h1 id="hello">Hello from Vercel Sandbox!</h1>' +
    '<p>path: ' + req.url + '</p>' +
    '</body></html>'
  );
}).listen(PORT, '0.0.0.0', () => {
  console.log('listening on ' + PORT);
});
`

async function main() {
  console.log('[M1] creating sandbox...')
  const t0 = Date.now()
  const sandbox = await Sandbox.create({
    runtime: 'node22',
    ports: [3000],
    timeout: ms('10m'),
  })
  console.log(`[M1] sandbox created in ${Date.now() - t0}ms  id=${sandbox.sandboxId}`)

  try {
    console.log('[M1] writing server.js into sandbox...')
    await sandbox.writeFiles([
      { path: 'server.js', content: Buffer.from(SERVER_JS, 'utf8') },
    ])

    console.log('[M1] starting http server (detached)...')
    const server = await sandbox.runCommand({
      cmd: 'node',
      args: ['server.js'],
      detached: true,
    })
    console.log(`[M1]   cmdId=${server.cmdId}`)

    // Tiny wait so the listener binds before we hit it.
    await new Promise((r) => setTimeout(r, 1500))

    const url = sandbox.domain(3000)
    console.log(`[M1] public URL: ${url}`)

    // --- Risk 2: public URL actually routes to the sandbox process ---
    console.log('[M1] fetching URL via fetch()...')
    const res = await fetch(url)
    const html = await res.text()
    console.log(`[M1]   HTTP ${res.status}, ${html.length} bytes`)
    if (!html.includes('Hello from Vercel Sandbox')) {
      throw new Error(`unexpected response body:\n${html.slice(0, 400)}`)
    }

    // --- Risk 3: Playwright can drive it ---
    console.log('[M1] launching local Playwright chromium...')
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('#hello')
      const shot = await page.screenshot({ fullPage: true })
      await mkdir('tmp', { recursive: true })
      await writeFile('tmp/m1-screenshot.png', shot)
      console.log(`[M1]   screenshot: ${shot.length} bytes → tmp/m1-screenshot.png`)
      if (shot.length < 5_000) {
        throw new Error('screenshot suspiciously small')
      }
    } finally {
      await browser.close()
    }

    console.log('\n[M1] ✅ all three risks retired')
    console.log(`[M1]    total wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  } finally {
    console.log('[M1] stopping sandbox...')
    await sandbox.stop()
    console.log('[M1] done')
  }
}

main().catch((err) => {
  console.error('\n[M1] ❌ failure:', err)
  process.exit(1)
})
