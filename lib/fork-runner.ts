/**
 * Phased adversarial fork runner.
 *
 * Each phase targets a different page in the buggy shop. Strategies in a phase
 * run in parallel (4 headed Chromium windows in a 2×2 grid). When one phase
 * finishes, the next phase starts — so you see waves of windows exploring the
 * app end-to-end. A buggy window stays open for inspection during its phase.
 *
 * Phase 1 — /cart      probes cart-page validation (qty overflow, negative, NaN)
 * Phase 2 — /checkout  probes checkout race + missing-email + XSS
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startBuggyServer } from './buggy-cart-server'
import { emit } from './runs'

type Stats = { dialogsSeen: number; httpErrors: number }

type Strategy = {
  name: string
  description: string
  banner: string
  bannerColor: string
  expectedOutcome: 'ok' | 'duplicate' | 'server_error' | 'xss_fired' | 'overflow' | 'negative_total' | 'nan_total'
  action: (page: Page) => Promise<Stats>
}

type Phase = {
  id: string
  index: number
  title: string
  initialPath: string
  /** If set, all forks in this phase hang off this fork in the tree UI. */
  parentForkId?: string
  strategies: Strategy[]
}

const mkTracker = (page: Page): Stats => {
  const stats: Stats = { dialogsSeen: 0, httpErrors: 0 }
  page.on('dialog', async (d) => {
    stats.dialogsSeen++
    await d.dismiss().catch(() => {})
  })
  page.on('response', (r) => {
    if (r.status() >= 500) stats.httpErrors++
  })
  return stats
}

// ---------- Phase 1 strategies: /cart ----------

const cartStrategies: Strategy[] = [
  {
    name: 'cart-control-proceed',
    description: 'proceed to checkout with the cart as-is',
    banner: '🟢 CONTROL — proceed to checkout',
    bannerColor: '#16a34a',
    expectedOutcome: 'ok',
    action: async (page) => {
      const stats = mkTracker(page)
      await page.click('#checkout-link')
      await page.waitForURL(/\/checkout/, { timeout: 5000 }).catch(() => {})
      return stats
    },
  },
  {
    name: 'cart-overflow-qty',
    description: 'set quantity to 999999 — watch the total explode',
    banner: '🟠 OVERFLOW — qty = 999999',
    bannerColor: '#ea580c',
    expectedOutcome: 'overflow',
    action: async (page) => {
      const stats = mkTracker(page)
      const first = page.locator('input[data-idx]').first()
      await first.click()
      await first.fill('999999')
      await first.press('Tab')
      await page.waitForTimeout(600)
      return stats
    },
  },
  {
    name: 'cart-negative-qty',
    description: 'set quantity to -5 — total should never be negative',
    banner: '🔴 NEGATIVE — qty = -5',
    bannerColor: '#dc2626',
    expectedOutcome: 'negative_total',
    action: async (page) => {
      const stats = mkTracker(page)
      const first = page.locator('input[data-idx]').first()
      await first.click()
      await first.fill('-5')
      await first.press('Tab')
      await page.waitForTimeout(600)
      return stats
    },
  },
  {
    name: 'cart-nan-qty',
    description: 'set quantity to "abc" — the total becomes NaN',
    banner: '🟣 TYPE CONFUSION — qty = "abc"',
    bannerColor: '#9333ea',
    expectedOutcome: 'nan_total',
    action: async (page) => {
      const stats = mkTracker(page)
      const first = page.locator('input[data-idx]').first()
      await first.click()
      // number inputs reject letters, but we can bypass via JS
      await page.evaluate(() => {
        const inp = document.querySelector('input[data-idx]') as HTMLInputElement
        inp.value = 'abc'
        inp.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await page.waitForTimeout(600)
      return stats
    },
  },
]

// ---------- Phase 2 strategies: /checkout ----------

const checkoutStrategies: Strategy[] = [
  {
    name: 'ck-control-normal-submit',
    description: 'fill the form correctly and submit once',
    banner: '🟢 CONTROL — submit normally',
    bannerColor: '#16a34a',
    expectedOutcome: 'ok',
    action: async (page) => {
      const stats = mkTracker(page)
      await page.fill('#email', 'friend@example.com')
      await page.fill('#name', 'Normal Jane')
      await page.fill('#card', '4242424242424242')
      await page.click('#place')
      await page.waitForTimeout(2000)
      return stats
    },
  },
  {
    name: 'ck-race-double-submit',
    description: 'double-click the place-order button',
    banner: '🔴 RACE — double-click place order',
    bannerColor: '#dc2626',
    expectedOutcome: 'duplicate',
    action: async (page) => {
      const stats = mkTracker(page)
      await page.fill('#email', 'racer@example.com')
      await page.fill('#name', 'Double Clicker')
      await page.fill('#card', '4242424242424242')
      await Promise.all([page.click('#place'), page.click('#place')])
      await page.waitForTimeout(2000)
      return stats
    },
  },
  {
    name: 'ck-missing-email',
    description: 'submit with no email',
    banner: '🟡 VALIDATION — submit with empty email',
    bannerColor: '#ca8a04',
    expectedOutcome: 'server_error',
    action: async (page) => {
      const stats = mkTracker(page)
      await page.fill('#name', 'No Email Nelly')
      await page.fill('#card', '4242424242424242')
      // deliberately leave #email blank
      await page.click('#place')
      await page.waitForTimeout(2000)
      return stats
    },
  },
  {
    name: 'ck-xss-in-name',
    description: 'name field contains an XSS payload',
    banner: '🟣 INJECTION — XSS payload in name',
    bannerColor: '#9333ea',
    expectedOutcome: 'xss_fired',
    action: async (page) => {
      const stats = mkTracker(page)
      await page.fill('#email', 'xss@example.com')
      await page.fill('#name', `<img src=x onerror="alert('XSS:' + document.domain)">`)
      await page.fill('#card', '4242424242424242')
      await page.click('#place')
      await page.waitForTimeout(2500)
      return stats
    },
  },
]

const phases: Phase[] = [
  {
    id: 'cart',
    index: 0,
    title: 'Phase 1 · /cart',
    initialPath: '/cart',
    strategies: cartStrategies,
    // parentForkId: undefined → these hang off the root
  },
  {
    id: 'checkout',
    index: 1,
    title: 'Phase 2 · /checkout',
    initialPath: '/checkout',
    strategies: checkoutStrategies,
    // Phase 2 branches down from the phase-1 fork that continued to /checkout
    parentForkId: 'cart.cart-control-proceed',
  },
]

// ---------- Grid layout (fits a 1440×900 screen with 40px margin) ----------

const GRID = [
  { x: 10,  y: 30  },
  { x: 710, y: 30  },
  { x: 10,  y: 460 },
  { x: 710, y: 460 },
]
const WIN_W = 680
const WIN_H = 410
const VIEWPORT = { width: 660, height: 360 }
const SLOW_MO_MS = 1000

async function injectBanner(page: Page, text: string, color: string) {
  await page
    .evaluate(
      ({ text, color }) => {
        const existing = document.getElementById('__fork_banner')
        if (existing) existing.remove()
        const b = document.createElement('div')
        b.id = '__fork_banner'
        b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:99999;padding:0.75rem 1rem;background:${color};color:#fff;font-weight:700;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,0.5);letter-spacing:0.02em;font-family:system-ui;font-size:14px`
        b.textContent = text
        document.body.appendChild(b)
      },
      { text, color }
    )
    .catch(() => {})
}

async function evaluateCartVerdict(
  page: Page,
  strategy: Strategy,
  stats: Stats
): Promise<{ verdict: 'passed' | 'bug' | 'tolerable' | 'error'; detail: string }> {
  // Read the displayed total as seen by the user on /cart.
  const total = await page
    .evaluate(() => {
      const el = document.getElementById('total')
      if (!el) return null
      const m = (el.textContent ?? '').match(/-?[\d.]+|NaN|Infinity/)
      return m ? m[0] : null
    })
    .catch(() => null)

  const numericOrSpecial = total ?? ''
  const parsed = Number(numericOrSpecial)

  if (strategy.expectedOutcome === 'ok') {
    // Control: should navigate to /checkout
    const onCheckout = page.url().includes('/checkout')
    return onCheckout
      ? { verdict: 'passed', detail: 'reached /checkout' }
      : { verdict: 'tolerable', detail: `stuck at ${page.url()}` }
  }
  if (strategy.expectedOutcome === 'overflow') {
    const isHuge = isFinite(parsed) && parsed > 1_000_000
    return isHuge
      ? { verdict: 'bug', detail: `total displayed: ${numericOrSpecial} (no max-qty guard)` }
      : { verdict: 'tolerable', detail: `total: ${numericOrSpecial}` }
  }
  if (strategy.expectedOutcome === 'negative_total') {
    const neg = isFinite(parsed) && parsed < 0
    return neg
      ? { verdict: 'bug', detail: `negative total: ${numericOrSpecial}` }
      : { verdict: 'tolerable', detail: `total: ${numericOrSpecial}` }
  }
  if (strategy.expectedOutcome === 'nan_total') {
    const nan = /NaN/i.test(numericOrSpecial) || Number.isNaN(parsed)
    return nan
      ? { verdict: 'bug', detail: `total became NaN — qty input not type-validated` }
      : { verdict: 'tolerable', detail: `total: ${numericOrSpecial}` }
  }
  return { verdict: 'tolerable', detail: 'no signal' }
}

async function evaluateCheckoutVerdict(
  page: Page,
  strategy: Strategy,
  stats: Stats,
  serverUrl: string
): Promise<{ verdict: 'passed' | 'bug' | 'tolerable' | 'error'; detail: string; ordersCreated: number }> {
  const orderResp = await page
    .evaluate((u) => fetch(u + '/api/orders').then((r) => r.json()).catch(() => ({ orders: [] })), serverUrl)
    .catch(() => ({ orders: [] }))
  const ordersCreated = (orderResp as any).orders?.length ?? 0

  if (strategy.expectedOutcome === 'xss_fired') {
    return stats.dialogsSeen > 0
      ? { verdict: 'bug', detail: `XSS fired — ${stats.dialogsSeen} dialog(s)`, ordersCreated }
      : { verdict: 'tolerable', detail: 'no dialog captured', ordersCreated }
  }
  if (strategy.expectedOutcome === 'server_error') {
    return stats.httpErrors > 0
      ? { verdict: 'bug', detail: `server 500 — validation missing`, ordersCreated }
      : { verdict: 'tolerable', detail: `http OK (orders=${ordersCreated})`, ordersCreated }
  }
  if (strategy.expectedOutcome === 'duplicate') {
    const excess = ordersCreated - 1
    return excess > 0
      ? { verdict: 'bug', detail: `duplicate orders: ${ordersCreated} (expected 1)`, ordersCreated }
      : { verdict: 'tolerable', detail: `orders=${ordersCreated}`, ordersCreated }
  }
  if (strategy.expectedOutcome === 'ok') {
    return ordersCreated === 1
      ? { verdict: 'passed', detail: `1 order created`, ordersCreated }
      : { verdict: 'tolerable', detail: `orders=${ordersCreated}`, ordersCreated }
  }
  return { verdict: 'tolerable', detail: 'no signal', ordersCreated }
}

// ---------- Runner ----------

async function runPhase(
  runId: string,
  phase: Phase,
  serverUrl: string
): Promise<{ bugsFound: number }> {
  emit(runId, {
    type: 'phase_started',
    phaseId: phase.id,
    phaseTitle: phase.title,
    phaseIndex: phase.index,
    at: Date.now(),
  })

  // One-time setup: put cart in interesting state, capture storageState.
  const setupBrowser = await chromium.launch()
  const setupCtx = await setupBrowser.newContext()
  const setupPage = await setupCtx.newPage()
  await setupPage.goto(serverUrl)
  await setupPage.click('button[data-sku="widget"]')
  await setupPage.click('button[data-sku="gadget"]')
  await setupPage.waitForFunction(() =>
    JSON.parse(localStorage.getItem('cart') || '[]').length >= 2
  )
  const fullState = await setupCtx.storageState()
  const forkState = { cookies: [], origins: fullState.origins } as any
  await setupCtx.close()
  await setupBrowser.close()

  // Announce forks up-front
  for (const strategy of phase.strategies) {
    emit(runId, {
      type: 'fork_created',
      forkId: `${phase.id}.${strategy.name}`,
      strategyName: strategy.name,
      description: strategy.description,
      intent: 1,
      phaseId: phase.id,
      phaseIndex: phase.index,
      parentForkId: phase.parentForkId,
    })
  }

  await new Promise((r) => setTimeout(r, 500))

  let bugsFound = 0

  await Promise.all(
    phase.strategies.map(async (strategy, slot) => {
      const forkId = `${phase.id}.${strategy.name}`
      const { x, y } = GRID[slot]
      const t0 = Date.now()

      emit(runId, { type: 'fork_status', forkId, status: 'navigating' })

      const forkBrowser: Browser = await chromium.launch({
        headless: false,
        slowMo: SLOW_MO_MS,
        args: [
          `--window-position=${x},${y}`,
          `--window-size=${WIN_W},${WIN_H}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-features=Translate',
        ],
      })

      let ctx: BrowserContext | null = null
      let keepOpen = false
      try {
        ctx = await forkBrowser.newContext({ storageState: forkState, viewport: VIEWPORT })
        const page = await ctx.newPage()
        await page.goto(serverUrl + phase.initialPath)
        await injectBanner(page, strategy.banner, strategy.bannerColor)
        emit(runId, {
          type: 'fork_status',
          forkId,
          status: 'acting',
          detail: strategy.description,
        })
        await page.waitForTimeout(1000)

        let error: string | undefined
        let stats: Stats = { dialogsSeen: 0, httpErrors: 0 }
        try {
          stats = await strategy.action(page)
        } catch (e: any) {
          error = e?.message ?? String(e)
        }

        // small settle time
        await page.waitForTimeout(800)

        // Re-inject banner if the page navigated (e.g. success page)
        if (page.url() !== serverUrl + phase.initialPath) {
          await injectBanner(
            page,
            `${strategy.banner}  →  landed on ${new URL(page.url()).pathname}`,
            strategy.bannerColor
          )
        }

        let verdict: 'passed' | 'bug' | 'tolerable' | 'error' = 'tolerable'
        let detail = ''
        let ordersCreated = 0

        if (error) {
          verdict = 'error'
          detail = error.slice(0, 120)
        } else if (phase.id === 'cart') {
          const v = await evaluateCartVerdict(page, strategy, stats)
          verdict = v.verdict
          detail = v.detail
        } else {
          const v = await evaluateCheckoutVerdict(page, strategy, stats, serverUrl)
          verdict = v.verdict
          detail = v.detail
          ordersCreated = v.ordersCreated
        }

        if (verdict === 'bug') bugsFound++
        keepOpen = verdict === 'bug' || verdict === 'error'

        // Final linger with outcome banner
        await page.waitForTimeout(2000)

        if (keepOpen) {
          await injectBanner(
            page,
            `🐛 BUG FOUND — ${strategy.name}  ·  ${detail}  ·  ⌘W to close`,
            '#dc2626'
          )
          await page.bringToFront().catch(() => {})
        }

        emit(runId, { type: 'fork_status', forkId, status: verdict })
        emit(runId, {
          type: 'fork_complete',
          forkId,
          ordersCreated,
          durMs: Date.now() - t0,
          verdict,
          excess: ordersCreated > 1 ? ordersCreated - 1 : undefined,
          error,
          bugDetail: detail,
        })
      } finally {
        if (!keepOpen) {
          await forkBrowser.close().catch(() => {})
        }
      }
    })
  )

  emit(runId, {
    type: 'phase_complete',
    phaseId: phase.id,
    phaseIndex: phase.index,
    at: Date.now(),
  })

  return { bugsFound }
}

export async function runForkExperiment(runId: string): Promise<void> {
  const server = await startBuggyServer(0)
  emit(runId, { type: 'run_started', runId, targetUrl: server.url, at: Date.now() })

  try {
    let totalBugs = 0
    let totalForks = 0
    for (const phase of phases) {
      const { bugsFound } = await runPhase(runId, phase, server.url)
      totalBugs += bugsFound
      totalForks += phase.strategies.length
      // small pause between phases so viewer can register the transition
      await new Promise((r) => setTimeout(r, 1500))
    }

    emit(runId, {
      type: 'run_complete',
      runId,
      bugsFound: totalBugs,
      totalForks,
      at: Date.now(),
    })
  } finally {
    await server.stop()
  }
}
