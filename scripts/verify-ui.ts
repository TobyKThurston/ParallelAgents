/**
 * Playwright verify — drives the Next.js UI end-to-end and screenshots the tree.
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

async function main() {
  await mkdir('tmp', { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } } as any)
  const consoleErrors: string[] = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))

  console.log('[verify] GET /')
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' })
  await page.screenshot({ path: 'tmp/ui-1-landing.png' })

  console.log('[verify] click "Start a run"')
  await page.click('button.start-btn')
  await page.waitForURL(/\/runs\/run_/, { timeout: 10_000 })
  const runUrl = page.url()
  console.log('[verify] redirected to', runUrl)

  // Wait for all fork nodes to enter a final state (bug / passed / tolerable / error)
  console.log('[verify] waiting for tree to populate + finalize...')
  await page.waitForSelector('.react-flow__node', { timeout: 15_000 })

  // Wait for summary card (run_complete event)
  await page.waitForSelector('.summary-card', { timeout: 30_000 })
  await page.waitForTimeout(300) // let final animations settle

  const summary = await page.evaluate(() => document.querySelector('.summary-card')?.textContent)
  const nodeCount = await page.locator('.react-flow__node').count()
  console.log(`[verify] nodeCount=${nodeCount}  summary="${summary}"`)

  await page.screenshot({ path: 'tmp/ui-2-complete.png', fullPage: false })
  console.log('[verify] screenshots → tmp/ui-1-landing.png, tmp/ui-2-complete.png')

  if (consoleErrors.length) {
    console.log('[verify] ⚠️ console errors:')
    for (const e of consoleErrors) console.log('  ', e.slice(0, 200))
  } else {
    console.log('[verify] ✅ no console errors')
  }

  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
