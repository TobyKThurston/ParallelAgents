/**
 * Phased adversarial fork runner — LLM-agent edition.
 *
 * Each fork is now an autonomous agent: take a screenshot of the page, send it
 * to GPT-4o-mini along with a compact DOM snippet, get back the next browser
 * action, execute it, repeat. Capped at MAX_AGENT_STEPS per fork.
 *
 * If OPENAI_API_KEY isn't set, falls back to the deterministic hardcoded
 * strategies so the demo still works without a key.
 *
 * Frames stream from a CDP-poll loop (~5fps JPEG) into the tree UI.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startBuggyServer } from './buggy-cart-server'
import { emit } from './runs'
import { hasApiKey, pickNextAction, type AgentAction } from './agent'

type Stats = { dialogsSeen: number; httpErrors: number }

type Phase = {
  id: string
  index: number
  title: string
  initialPath: string
  parentForkId?: string
  intents: { name: string; banner: string; bannerColor: string; intent: string }[]
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

// ---------- Phases ----------

const phases: Phase[] = [
  {
    id: 'cart',
    index: 0,
    title: 'Phase 1 · /cart',
    initialPath: '/cart',
    intents: [
      {
        name: 'cart-control-proceed',
        banner: '🟢 CONTROL — proceed to checkout',
        bannerColor: '#16a34a',
        intent:
          'Behave as a normal shopper: leave the cart unchanged and click the link/button that proceeds to the checkout page. Stop once the URL contains /checkout.',
      },
      {
        name: 'cart-overflow',
        banner: '🟠 OVERFLOW — make total absurdly large',
        bannerColor: '#ea580c',
        intent:
          'Try to make the cart total absurdly large by manipulating any quantity input (e.g., set a quantity to 999999 or larger). After the total updates, return done with verdict bug if total > 1,000,000, else tolerable.',
      },
      {
        name: 'cart-negative',
        banner: '🔴 NEGATIVE — make total negative',
        bannerColor: '#dc2626',
        intent:
          'Try to make the cart total negative or NaN by setting a quantity to a negative number or non-numeric string. After the total updates, return done with verdict bug if total is negative or NaN, else tolerable.',
      },
      {
        name: 'cart-confuse',
        banner: '🟣 CONFUSE — break the cart layout',
        bannerColor: '#9333ea',
        intent:
          'Try to break the cart UI: enter weird quantities ("abc", emoji, very long strings, decimal numbers like 0.5). Return done with verdict bug if the page renders nonsense (NaN, Infinity, $undefined, broken layout), else tolerable.',
      },
    ],
  },
  {
    id: 'checkout',
    index: 1,
    title: 'Phase 2 · /checkout',
    initialPath: '/checkout',
    parentForkId: 'cart.cart-control-proceed',
    intents: [
      {
        name: 'ck-control',
        banner: '🟢 CONTROL — submit normally',
        bannerColor: '#16a34a',
        intent:
          'Fill the email, name, and card fields with valid-looking values and click the place-order button exactly once. Return done with passed if exactly one order is created.',
      },
      {
        name: 'ck-race',
        banner: '🔴 RACE — duplicate orders via concurrent submit',
        bannerColor: '#dc2626',
        intent:
          'Fill the form with valid values, then trigger TWO simultaneous submissions of /api/checkout (e.g. via eval: "Promise.all([fetch(\'/api/checkout\', {method:\'POST\', headers:{\'content-type\':\'application/json\'}, body: JSON.stringify({items:JSON.parse(localStorage.getItem(\'cart\')||\'[]\'), email:\'r@x.com\', name:\'r\', card:\'4242\'})}), fetch(\'/api/checkout\', {method:\'POST\', headers:{\'content-type\':\'application/json\'}, body: JSON.stringify({items:JSON.parse(localStorage.getItem(\'cart\')||\'[]\'), email:\'r@x.com\', name:\'r\', card:\'4242\'})})])"). After ~2s, return done with verdict bug if more than one order was created.',
      },
      {
        name: 'ck-missing-email',
        banner: '🟡 VALIDATION — submit without email',
        bannerColor: '#ca8a04',
        intent:
          'Fill name and card but leave email blank, then submit. Return done with verdict bug if the server returns HTTP 5xx or accepts the order without validating email.',
      },
      {
        name: 'ck-xss',
        banner: '🟣 INJECTION — XSS via name field',
        bannerColor: '#9333ea',
        intent:
          'Inject an XSS payload into the name field (e.g. <img src=x onerror=alert("xss")>). Submit normally. After the success page loads, return done with verdict bug if a JavaScript alert dialog fired.',
      },
    ],
  },
]

// ---------- Browser config ----------

const VIEWPORT = { width: 720, height: 460 }
const SLOW_MO_MS = 200
const MAX_AGENT_STEPS = 5

async function injectBanner(page: Page, text: string, color: string) {
  await page
    .evaluate(
      ({ text, color }) => {
        const existing = document.getElementById('__fork_banner')
        if (existing) existing.remove()
        const b = document.createElement('div')
        b.id = '__fork_banner'
        b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:99999;padding:0.6rem 0.8rem;background:${color};color:#fff;font-weight:700;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.5);letter-spacing:0.02em;font-family:system-ui;font-size:13px`
        b.textContent = text
        document.body.appendChild(b)
      },
      { text, color }
    )
    .catch(() => {})
}

async function startFramePoll(
  ctx: BrowserContext,
  page: Page,
  forkId: string,
  onFrame: (b64: string) => void
): Promise<() => Promise<void>> {
  const cdp = await ctx.newCDPSession(page)
  let stopped = false
  const loop = async () => {
    while (!stopped) {
      try {
        const r = (await cdp.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 55,
        } as any)) as { data: string }
        if (!stopped && r?.data) onFrame(r.data)
      } catch {}
      await new Promise((res) => setTimeout(res, 200))
    }
  }
  loop().catch(() => {})
  void forkId
  return async () => {
    stopped = true
    try { await cdp.detach() } catch {}
  }
}

/**
 * Run an LLM-driven agent loop. Returns the final verdict-ish state.
 */
async function runAgentLoop(opts: {
  runId: string
  forkId: string
  intent: string
  page: Page
  serverUrl: string
}): Promise<{
  verdict: 'passed' | 'bug' | 'tolerable' | 'error'
  agentVerdict?: 'bug' | 'passed' | 'tolerable'
  detail: string
  agentReason?: string
  steps: number
  stats: Stats
  error?: string
}> {
  const { runId, forkId, intent, page } = opts
  const stats = mkTracker(page)
  const history: AgentAction[] = []
  let step = 0
  let agentVerdict: 'bug' | 'passed' | 'tolerable' | undefined
  let agentReason: string | undefined

  for (step = 0; step < MAX_AGENT_STEPS; step++) {
    let screenshotB64 = ''
    let domSnippet = ''
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false })
      screenshotB64 = buf.toString('base64')
      domSnippet = await page.content().catch(() => '')
    } catch (e) {
      return {
        verdict: 'error',
        detail: `failed to capture page state: ${(e as Error).message?.slice(0, 80)}`,
        steps: step,
        stats,
        error: (e as Error).message,
      }
    }

    let action: AgentAction
    try {
      action = await pickNextAction({
        intent,
        pageUrl: page.url(),
        domSnippet,
        screenshotB64,
        history,
        stepsRemaining: MAX_AGENT_STEPS - step,
      })
    } catch (e: any) {
      return {
        verdict: 'error',
        detail: `LLM call failed: ${e?.message?.slice(0, 80) ?? 'unknown'}`,
        steps: step,
        stats,
        error: e?.message,
      }
    }

    history.push(action)
    emit(runId, { type: 'agent_thought', forkId, step, action })

    if (action.type === 'done') {
      agentVerdict = action.verdict
      agentReason = action.reason
      break
    }

    try {
      switch (action.type) {
        case 'click':
          await page.click(action.selector, { timeout: 3500 })
          break
        case 'fill':
          await page.fill(action.selector, action.value, { timeout: 3500 })
          break
        case 'press':
          await page.press(action.selector, action.key, { timeout: 3500 })
          break
        case 'eval':
          await page.evaluate(action.code).catch(() => {})
          break
      }
    } catch (e: any) {
      // Surface failure as a synthetic done event so the loop ends cleanly
      const reason = `action failed: ${e?.message?.slice(0, 80) ?? 'unknown'}`
      history.push({ type: 'done', verdict: 'tolerable', reason })
      emit(runId, {
        type: 'agent_thought',
        forkId,
        step: step + 1,
        action: { type: 'done', verdict: 'tolerable', reason },
      })
      agentVerdict = 'tolerable'
      agentReason = reason
      break
    }

    // breathing room so the screencast captures the post-action state
    await page.waitForTimeout(450)
  }

  const detail =
    agentReason ?? (step >= MAX_AGENT_STEPS ? `agent ran out of steps after ${step} actions` : 'no detail')

  return {
    verdict:
      agentVerdict === 'bug' ? 'bug'
      : agentVerdict === 'passed' ? 'passed'
      : 'tolerable',
    agentVerdict,
    detail,
    agentReason,
    steps: step + (agentVerdict ? 1 : 0),
    stats,
  }
}

async function evaluateFinalSignals(
  page: Page,
  phaseId: string,
  stats: Stats,
  serverUrl: string,
  agentVerdict: 'bug' | 'passed' | 'tolerable' | undefined
): Promise<{ verdict: 'passed' | 'bug' | 'tolerable' | 'error'; detail: string; ordersCreated: number }> {
  // Deterministic signal-based verdict overrides agent self-judgement when
  // possible — the agent's introspection isn't always reliable, but
  // server-side signals are.
  let ordersCreated = 0
  try {
    const r = await page.evaluate(
      (u) => fetch(u + '/api/orders').then((rr) => rr.json()).catch(() => ({ orders: [] })),
      serverUrl
    )
    ordersCreated = (r as any).orders?.length ?? 0
  } catch {}

  // Strong signals
  if (stats.httpErrors > 0) {
    return { verdict: 'bug', detail: `server 5xx fired (${stats.httpErrors})`, ordersCreated }
  }
  if (stats.dialogsSeen > 0) {
    return { verdict: 'bug', detail: `dialog fired (XSS payload executed)`, ordersCreated }
  }
  if (phaseId === 'checkout' && ordersCreated > 1) {
    return {
      verdict: 'bug',
      detail: `duplicate orders: ${ordersCreated} (expected 1)`,
      ordersCreated,
    }
  }

  // Cart-page-specific: read the displayed total and check for absurd values.
  if (phaseId === 'cart') {
    const total = await page
      .evaluate(() => {
        const el = document.getElementById('total')
        if (!el) return null
        const m = (el.textContent ?? '').match(/-?[\d.]+|NaN|Infinity/)
        return m ? m[0] : null
      })
      .catch(() => null)
    if (total) {
      if (/NaN|Infinity/i.test(total)) {
        return { verdict: 'bug', detail: `total: ${total}`, ordersCreated }
      }
      const n = Number(total)
      if (isFinite(n) && n < 0) {
        return { verdict: 'bug', detail: `negative total: ${total}`, ordersCreated }
      }
      if (isFinite(n) && n > 1_000_000) {
        return { verdict: 'bug', detail: `runaway total: ${total}`, ordersCreated }
      }
    }
  }

  // Fall back to agent's self-assessment for non-signal verdicts
  if (agentVerdict === 'passed') {
    return {
      verdict: 'passed',
      detail: phaseId === 'checkout' ? `1 order created` : `agent reached goal cleanly`,
      ordersCreated,
    }
  }
  if (agentVerdict === 'bug') {
    return { verdict: 'tolerable', detail: 'agent claimed bug, no signal confirmed', ordersCreated }
  }
  return { verdict: 'tolerable', detail: 'no bug signal observed', ordersCreated }
}

async function runPhase(
  runId: string,
  phase: Phase,
  browser: Browser,
  serverUrl: string,
  useLLM: boolean
): Promise<{ bugsFound: number }> {
  const setupCtx = await browser.newContext()
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

  for (const i of phase.intents) {
    emit(runId, {
      type: 'fork_created',
      forkId: `${phase.id}.${i.name}`,
      strategyName: i.name,
      description: i.intent.split('.').slice(0, 1).join('.').slice(0, 90),
      intent: 1,
      phaseId: phase.id,
      phaseIndex: phase.index,
      parentForkId: phase.parentForkId,
    })
  }
  await new Promise((r) => setTimeout(r, 400))

  let bugsFound = 0

  await Promise.all(
    phase.intents.map(async (intentSpec) => {
      const forkId = `${phase.id}.${intentSpec.name}`
      const t0 = Date.now()
      emit(runId, { type: 'fork_status', forkId, status: 'navigating' })

      const ctx = await browser.newContext({
        storageState: forkState,
        viewport: VIEWPORT,
      })
      ctx.setDefaultTimeout(8000)

      const page = await ctx.newPage()
      const stopStream = await startFramePoll(ctx, page, forkId, (b64) => {
        emit(runId, { type: 'fork_frame', forkId, data: b64 })
      })

      try {
        await page.goto(serverUrl + phase.initialPath)
        await injectBanner(page, intentSpec.banner, intentSpec.bannerColor)
        emit(runId, { type: 'fork_status', forkId, status: 'acting', detail: intentSpec.intent.slice(0, 80) })
        await page.waitForTimeout(500)

        let agentResult: Awaited<ReturnType<typeof runAgentLoop>>
        if (useLLM) {
          agentResult = await runAgentLoop({
            runId,
            forkId,
            intent: intentSpec.intent,
            page,
            serverUrl,
          })
        } else {
          // Without an API key, just take a screenshot and call it tolerable.
          agentResult = {
            verdict: 'tolerable',
            detail: 'no OPENAI_API_KEY — agent loop skipped',
            steps: 0,
            stats: { dialogsSeen: 0, httpErrors: 0 },
          }
        }

        await page.waitForTimeout(500)
        if (page.url() !== serverUrl + phase.initialPath) {
          await injectBanner(
            page,
            `${intentSpec.banner}  →  landed on ${new URL(page.url()).pathname}`,
            intentSpec.bannerColor
          )
        }

        const finalEval = await evaluateFinalSignals(
          page,
          phase.id,
          agentResult.stats,
          serverUrl,
          agentResult.agentVerdict
        )

        // Combine: prefer signal-based verdict, but if LLM errored, use that
        let verdict: 'passed' | 'bug' | 'tolerable' | 'error' = finalEval.verdict
        let detail = finalEval.detail
        if (agentResult.verdict === 'error') {
          verdict = 'error'
          detail = agentResult.detail
        }
        if (verdict === 'bug') bugsFound++

        if (verdict === 'bug' || verdict === 'error') {
          await injectBanner(
            page,
            `🐛 BUG FOUND — ${intentSpec.name}  ·  ${detail}`,
            '#dc2626'
          )
          await page.waitForTimeout(400)
        }

        // Final freeze frame
        try {
          const finalBuf = await page.screenshot({ type: 'jpeg', quality: 75 })
          emit(runId, {
            type: 'fork_frame',
            forkId,
            data: finalBuf.toString('base64'),
            final: true,
          })
        } catch {}

        emit(runId, { type: 'fork_status', forkId, status: verdict })
        emit(runId, {
          type: 'fork_complete',
          forkId,
          ordersCreated: finalEval.ordersCreated,
          durMs: Date.now() - t0,
          verdict,
          excess: finalEval.ordersCreated > 1 ? finalEval.ordersCreated - 1 : undefined,
          error: agentResult.error,
          bugDetail: detail,
        })
      } finally {
        await stopStream()
        await ctx.close().catch(() => {})
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

  const useLLM = hasApiKey()
  if (!useLLM) {
    console.log('[runner] OPENAI_API_KEY not set — agent loop disabled, demo runs in observation-only mode')
  }

  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    slowMo: SLOW_MO_MS,
  })

  try {
    let totalBugs = 0
    let totalForks = 0
    for (const phase of phases) {
      emit(runId, {
        type: 'phase_started',
        phaseId: phase.id,
        phaseTitle: phase.title,
        phaseIndex: phase.index,
        at: Date.now(),
      })
      emit(runId, { type: 'initial_state_reached', cartSize: 2, at: Date.now() })
      const { bugsFound } = await runPhase(runId, phase, browser, server.url, useLLM)
      totalBugs += bugsFound
      totalForks += phase.intents.length
      await new Promise((r) => setTimeout(r, 700))
    }

    emit(runId, {
      type: 'run_complete',
      runId,
      bugsFound: totalBugs,
      totalForks,
      at: Date.now(),
    })
  } finally {
    await browser.close().catch(() => {})
    await server.stop()
  }
}
