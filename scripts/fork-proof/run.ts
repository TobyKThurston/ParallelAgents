/**
 * Standalone fork-proof — same experiment as the Next.js app, but no UI.
 * Useful for quick terminal runs. See lib/fork-runner.ts for the event-emitting version.
 */

import { chromium, type Page } from 'playwright'
import { startBuggyServer } from '../../lib/buggy-cart-server'

type Strategy = {
  name: string
  description: string
  userIntentedCheckouts: number
  action: (page: Page) => Promise<void>
}

const strategies: Strategy[] = [
  {
    name: 'control-single-click',
    description: 'click checkout once like a normal user',
    userIntentedCheckouts: 1,
    action: async (page) => {
      await page.click('#checkout')
      await page.waitForResponse((r) => r.url().endsWith('/api/checkout'))
    },
  },
  {
    name: 'race-double-click',
    description: 'click checkout twice in rapid succession',
    userIntentedCheckouts: 1,
    action: async (page) => {
      await Promise.all([page.click('#checkout'), page.click('#checkout')])
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'race-triple-fire',
    description: 'trigger the checkout fetch 3x concurrently',
    userIntentedCheckouts: 1,
    action: async (page) => {
      await page.evaluate(() => {
        const cart = JSON.parse(localStorage.getItem('cart') || '[]')
        const body = JSON.stringify({ items: cart })
        const opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body }
        return Promise.all([
          fetch('/api/checkout', opts),
          fetch('/api/checkout', opts),
          fetch('/api/checkout', opts),
        ])
      })
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'abort-navigate-away',
    description: 'click checkout then navigate away before it completes',
    userIntentedCheckouts: 1,
    action: async (page) => {
      const clickP = page.click('#checkout')
      await page.waitForTimeout(20)
      await page.goto('about:blank').catch(() => {})
      await clickP.catch(() => {})
    },
  },
]

async function main() {
  console.log('starting buggy cart server ...')
  const server = await startBuggyServer(3100)
  console.log(`  ${server.url}`)

  const browser = await chromium.launch()
  try {
    console.log('\n[phase 1] reaching interesting state (2 items in cart)')
    const setupCtx = await browser.newContext()
    const setupPage = await setupCtx.newPage()
    await setupPage.goto(server.url)
    await setupPage.click('#add')
    await setupPage.click('#add')
    await setupPage.waitForFunction(() => document.getElementById('count')?.textContent === '2')
    const fullState = await setupCtx.storageState()
    const forkState = { cookies: [], origins: fullState.origins } as any
    await setupCtx.close()

    console.log('\n[phase 2] forking into 4 parallel realities\n')

    const results = await Promise.all(
      strategies.map(async (strategy) => {
        const t0 = Date.now()
        const ctx = await browser.newContext({ storageState: forkState })
        const page = await ctx.newPage()
        await page.goto(server.url)
        const cartLen = await page.evaluate(() => JSON.parse(localStorage.getItem('cart') || '[]').length)
        let error: string | undefined
        try { await strategy.action(page) } catch (e: any) { error = e?.message ?? String(e) }
        const orders = await page
          .evaluate(() => fetch('/api/orders').then((r) => r.json()).catch(() => ({ orders: [] })))
          .catch(() => ({ orders: [] }))
        await ctx.close()
        return {
          strategy,
          cartLen,
          ordersCreated: (orders as any).orders?.length ?? 0,
          durMs: Date.now() - t0,
          error,
        }
      })
    )

    console.log('━'.repeat(72))
    console.log('fork                       cart  intent  orders  verdict')
    console.log('━'.repeat(72))
    let bugsFound = 0
    for (const r of results) {
      const excess = r.ordersCreated - r.strategy.userIntentedCheckouts
      const verdict =
        excess > 0 ? `🐛 BUG (${excess} duplicate${excess > 1 ? 's' : ''})`
        : r.ordersCreated === r.strategy.userIntentedCheckouts ? '✅ as-expected'
        : r.strategy.name.startsWith('abort') && r.ordersCreated <= 1 ? '✅ tolerable'
        : '⚠️  under-count'
      if (excess > 0) bugsFound++
      console.log(
        `${r.strategy.name.padEnd(26)} ${String(r.cartLen).padStart(4)}  ${String(r.strategy.userIntentedCheckouts).padStart(6)}  ${String(r.ordersCreated).padStart(6)}  ${verdict}`
      )
    }
    console.log('━'.repeat(72))
    console.log()
    if (bugsFound > 0) console.log(`✅ fork primitive works — ${bugsFound} parallel-only bug(s) found`)
    else console.log('❌ no bugs found')
  } finally {
    await browser.close()
    await server.stop()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
