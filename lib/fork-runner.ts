/**
 * Multi-fork-point adversarial runner.
 *
 * The swarm chains through several fork points in the buggy SaaS app. At each
 * point, GPT-4o-mini looks at the page screenshot + DOM and generates 2-5
 * adversarial intents based on what's actually there (not always 4 forks).
 * Each generated intent then becomes its own headless Chromium context running
 * an agent loop: screenshot → LLM picks next browser action → execute → repeat.
 *
 * Topologically:
 *   ROOT
 *   ├── fp1.intent-A         (bug)
 *   ├── fp1.intent-B         (passed — the "control")
 *   │   ├── fp2.intent-A
 *   │   ├── fp2.intent-B
 *   │   └── fp2.intent-C
 *   ├── fp1.intent-C
 *   └── fp1.intent-D
 *
 * Frames stream into the tree UI via CDP captureScreenshot polling.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startBuggyServer } from './buggy-cart-server'
import { emit } from './runs'
import {
  hasApiKey,
  pickNextAction,
  generateIntents,
  type AgentAction,
  type GeneratedIntent,
} from './agent'

// ---------- Fork point catalog ----------

type ForkPoint = {
  id: string
  index: number
  title: string
  /** Path within the buggy app to navigate to before forking. */
  initialUrl: string
  /** Plain-English description of the page passed to generateIntents. */
  context: string
  /** id of the prior fork point this one chains from (parent will be that point's control). */
  chainsFrom?: string
  /** What server-side state to count toward "created N items" duplicate detection. */
  countStateKey?: 'issues' | 'orders'
}

const forkPoints: ForkPoint[] = [
  {
    id: 'fp-issue-create',
    index: 0,
    title: 'Phase 1 · /issues/new',
    initialUrl: '/issues/new',
    context:
      'A SaaS issue creation form. Inputs: title (required), description (textarea), priority dropdown (low/med/high), assignee. Submitting POSTs to /api/issues which creates a tracked issue. Empty title makes the server crash. The /issues list page renders titles via innerHTML (XSS reflection vulnerability). The endpoint has no idempotency key.',
    countStateKey: 'issues',
  },
  {
    id: 'fp-billing',
    index: 1,
    title: 'Phase 2 · /billing',
    initialUrl: '/billing',
    context:
      'A billing/checkout page for upgrading to the Pro plan. Inputs: seats (numeric, default 5, $10 each), coupon code, email, cardholder name, card number. Submits to /api/billing/checkout. Special coupons: FREE100 = 100% off; SAVE10 = 10% off. Empty email crashes the server. The success page reflects ?name= via innerHTML.',
    chainsFrom: 'fp-issue-create',
    countStateKey: 'orders',
  },
]

// ---------- Browser config ----------

const VIEWPORT = { width: 720, height: 460 }
const SLOW_MO_MS = 150
const MAX_AGENT_STEPS = 5

const FALLBACK_INTENTS: Record<string, GeneratedIntent[]> = {
  'fp-issue-create': [
    {
      name: 'control-create',
      banner: '🟢 CONTROL — create one normal issue',
      bannerColor: '#16a34a',
      description: 'Fill the title and assignee with reasonable values, click Create exactly once. Verify exactly one issue was created.',
    },
    {
      name: 'race-double-create',
      banner: '🔴 RACE — double-click create',
      bannerColor: '#dc2626',
      description: 'Fill the form normally, then click Create twice in quick succession. Bug if more than one issue is created.',
    },
    {
      name: 'missing-title',
      banner: '🟡 VALIDATION — submit with empty title',
      bannerColor: '#ca8a04',
      description: 'Leave the title field empty and click Create. Bug if the server returns 5xx or accepts the issue.',
    },
    {
      name: 'xss-in-title',
      banner: '🟣 INJECTION — XSS payload in title',
      bannerColor: '#9333ea',
      description: 'Set title to "<img src=x onerror=alert(1)>" and Create. Then visit /issues. Bug if a JS dialog fires (XSS).',
    },
  ],
  'fp-billing': [
    {
      name: 'control-pay',
      banner: '🟢 CONTROL — pay normally',
      bannerColor: '#16a34a',
      description: 'Fill all fields with valid values and Pay once. Verify a single order is created.',
    },
    {
      name: 'race-double-pay',
      banner: '🔴 RACE — concurrent pay',
      bannerColor: '#dc2626',
      description: 'Fill the form, then trigger two simultaneous POSTs to /api/billing/checkout. Bug if more than one order is created.',
    },
    {
      name: 'negative-seats',
      banner: '🟠 OVERFLOW — negative seat count',
      bannerColor: '#ea580c',
      description: 'Set seats to -5 and pay. Bug if the total goes negative or the order is accepted.',
    },
    {
      name: 'free100-coupon',
      banner: '🟣 ABUSE — coupon FREE100',
      bannerColor: '#9333ea',
      description: 'Apply coupon FREE100 (100% off) and pay. Bug if total reaches 0 or below without explicit refund.',
    },
    {
      name: 'missing-email',
      banner: '🟡 VALIDATION — submit with empty email',
      bannerColor: '#ca8a04',
      description: 'Leave email blank and Pay. Bug if the server crashes (5xx).',
    },
  ],
}

// ---------- Helpers ----------

const mkTracker = (page: Page) => {
  const stats = { dialogsSeen: 0, httpErrors: 0 }
  page.on('dialog', async (d) => {
    stats.dialogsSeen++
    await d.dismiss().catch(() => {})
  })
  page.on('response', (r) => {
    if (r.status() >= 500) stats.httpErrors++
  })
  return stats
}

async function injectBanner(page: Page, text: string, color: string) {
  await page
    .evaluate(
      ({ text, color }) => {
        const existing = document.getElementById('__fork_banner')
        if (existing) existing.remove()
        const b = document.createElement('div')
        b.id = '__fork_banner'
        b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:99999;padding:0.5rem 0.8rem;background:${color};color:#fff;font-weight:700;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.5);letter-spacing:0.02em;font-family:system-ui;font-size:12px`
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
      await new Promise((res) => setTimeout(res, 220))
    }
  }
  loop().catch(() => {})
  return async () => {
    stopped = true
    try { await cdp.detach() } catch {}
  }
}

async function runAgentLoop(opts: {
  runId: string
  forkId: string
  intent: string
  page: Page
}): Promise<{
  agentVerdict?: 'bug' | 'passed' | 'tolerable'
  agentReason?: string
  steps: number
  stats: { dialogsSeen: number; httpErrors: number }
  error?: string
}> {
  const { runId, forkId, intent, page } = opts
  const stats = mkTracker(page)
  const history: AgentAction[] = []
  let agentVerdict: 'bug' | 'passed' | 'tolerable' | undefined
  let agentReason: string | undefined
  let step = 0

  for (step = 0; step < MAX_AGENT_STEPS; step++) {
    let screenshotB64 = ''
    let dom = ''
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false })
      screenshotB64 = buf.toString('base64')
      dom = await page.content().catch(() => '')
    } catch (e) {
      return { steps: step, stats, error: (e as Error).message?.slice(0, 80) }
    }

    let action: AgentAction
    try {
      action = await pickNextAction({
        intent,
        pageUrl: page.url(),
        domSnippet: dom,
        screenshotB64,
        history,
        stepsRemaining: MAX_AGENT_STEPS - step,
      })
    } catch (e: any) {
      return { steps: step, stats, error: `LLM err: ${e?.message?.slice(0, 80) ?? 'unknown'}` }
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

    await page.waitForTimeout(400)
  }

  return {
    agentVerdict,
    agentReason,
    steps: step + (agentVerdict ? 1 : 0),
    stats,
  }
}

async function evaluateVerdict(
  page: Page,
  fp: ForkPoint,
  stats: { dialogsSeen: number; httpErrors: number },
  serverUrl: string,
  agentVerdict?: 'bug' | 'passed' | 'tolerable'
): Promise<{ verdict: 'passed' | 'bug' | 'tolerable'; detail: string; itemsCreated: number }> {
  // Strong signals first.
  if (stats.dialogsSeen > 0) {
    return {
      verdict: 'bug',
      detail: `XSS dialog fired (${stats.dialogsSeen})`,
      itemsCreated: 0,
    }
  }
  if (stats.httpErrors > 0) {
    return {
      verdict: 'bug',
      detail: `server 5xx fired (${stats.httpErrors}× — missing validation)`,
      itemsCreated: 0,
    }
  }

  // Server-side count for the relevant resource
  let itemsCreated = 0
  if (fp.countStateKey) {
    try {
      const path = fp.countStateKey === 'issues' ? '/api/issues' : '/api/orders'
      const r = await page.evaluate(
        (u) => fetch(u).then((rr) => rr.json()).catch(() => ({})),
        serverUrl + path
      )
      const arr = (r as any)[fp.countStateKey]
      itemsCreated = Array.isArray(arr) ? arr.length : 0
    } catch {}
  }

  if (itemsCreated > 1) {
    return {
      verdict: 'bug',
      detail: `${itemsCreated} ${fp.countStateKey} created (expected 1) — race`,
      itemsCreated,
    }
  }

  // Billing-specific: total goes negative or zero unintentionally
  if (fp.id === 'fp-billing' && itemsCreated >= 1) {
    try {
      const r = await page.evaluate((u) => fetch(u + '/api/orders').then((rr) => rr.json()), serverUrl)
      const orders = (r as any).orders ?? []
      const last = orders[orders.length - 1]
      if (last && typeof last.total === 'number' && last.total < 0) {
        return { verdict: 'bug', detail: `negative total: $${last.total}`, itemsCreated }
      }
      if (last && typeof last.total === 'number' && last.total === 0) {
        return { verdict: 'bug', detail: `coupon abuse: $0 total`, itemsCreated }
      }
    } catch {}
  }

  if (agentVerdict === 'passed' && itemsCreated === 1) {
    return { verdict: 'passed', detail: `created 1 ${fp.countStateKey ?? 'item'}`, itemsCreated }
  }
  if (agentVerdict === 'bug') {
    return { verdict: 'tolerable', detail: 'agent claimed bug, no signal confirmed', itemsCreated }
  }
  if (itemsCreated === 1) {
    return { verdict: 'passed', detail: `created 1 ${fp.countStateKey ?? 'item'}`, itemsCreated }
  }
  return { verdict: 'tolerable', detail: 'no bug signal observed', itemsCreated }
}

// ---------- Per-fork-point runner ----------

async function runForkPoint(opts: {
  runId: string
  fp: ForkPoint
  browser: Browser
  serverUrl: string
  parentForkId: string | undefined
  useLLM: boolean
}): Promise<{ bugsFound: number; controlForkId: string | undefined; intentsRun: number }> {
  const { runId, fp, browser, serverUrl, parentForkId, useLLM } = opts

  emit(runId, {
    type: 'phase_started',
    phaseId: fp.id,
    phaseTitle: fp.title,
    phaseIndex: fp.index,
    at: Date.now(),
  })

  // Warm a context to the fork-point URL and snapshot its state.
  const warmCtx = await browser.newContext({ viewport: VIEWPORT })
  const warmPage = await warmCtx.newPage()
  try {
    await warmPage.goto(serverUrl + fp.initialUrl)
    await warmPage.waitForLoadState('domcontentloaded').catch(() => {})
  } catch (e) {
    console.log(`[runner ${fp.id}] warm goto failed:`, (e as Error).message)
  }

  // Generate intents from a screenshot + DOM (or fall back).
  let intents: GeneratedIntent[]
  if (useLLM) {
    try {
      const buf = await warmPage.screenshot({ type: 'jpeg', quality: 60 })
      const dom = await warmPage.content().catch(() => '')
      intents = await generateIntents({
        pageUrl: warmPage.url(),
        domSnippet: dom,
        screenshotB64: buf.toString('base64'),
        context: fp.context,
      })
      console.log(`[runner ${fp.id}] LLM proposed ${intents.length} intents:`, intents.map((i) => i.name).join(', '))
    } catch (e: any) {
      console.log(`[runner ${fp.id}] generateIntents failed, using fallback:`, e?.message)
      intents = FALLBACK_INTENTS[fp.id] ?? FALLBACK_INTENTS['fp-issue-create']
    }
  } else {
    intents = FALLBACK_INTENTS[fp.id] ?? FALLBACK_INTENTS['fp-issue-create']
  }

  // Capture the warm storageState so all forks can resume from the same point.
  const fullState = await warmCtx.storageState()
  const forkState = { cookies: [], origins: fullState.origins } as any
  await warmCtx.close()

  // Pick the control fork — first green-bannered intent, or the first intent.
  const controlIntent =
    intents.find((i) => i.bannerColor === '#16a34a') ?? intents[0]
  const controlForkId = controlIntent
    ? `${fp.id}.${controlIntent.name}`
    : undefined

  // Announce all forks up-front so the UI renders placeholders.
  for (const intent of intents) {
    emit(runId, {
      type: 'fork_created',
      forkId: `${fp.id}.${intent.name}`,
      strategyName: intent.name,
      description: intent.description.slice(0, 120),
      intent: 1,
      phaseId: fp.id,
      phaseIndex: fp.index,
      parentForkId,
    })
  }

  await new Promise((r) => setTimeout(r, 300))

  let bugsFound = 0

  await Promise.all(
    intents.map(async (intent) => {
      const forkId = `${fp.id}.${intent.name}`
      const t0 = Date.now()
      emit(runId, { type: 'fork_status', forkId, status: 'navigating' })

      const ctx = await browser.newContext({
        storageState: forkState,
        viewport: VIEWPORT,
      })
      ctx.setDefaultTimeout(8000)
      const page = await ctx.newPage()
      const stopStream = await startFramePoll(ctx, page, (b64) => {
        emit(runId, { type: 'fork_frame', forkId, data: b64 })
      })

      try {
        await page.goto(serverUrl + fp.initialUrl)
        await injectBanner(page, intent.banner, intent.bannerColor)
        emit(runId, {
          type: 'fork_status',
          forkId,
          status: 'acting',
          detail: intent.description.slice(0, 80),
        })
        await page.waitForTimeout(400)

        let agentResult: Awaited<ReturnType<typeof runAgentLoop>>
        if (useLLM) {
          agentResult = await runAgentLoop({
            runId,
            forkId,
            intent: intent.description,
            page,
          })
        } else {
          agentResult = {
            steps: 0,
            stats: { dialogsSeen: 0, httpErrors: 0 },
            error: 'no OPENAI_API_KEY — agent loop skipped',
          }
        }

        await page.waitForTimeout(400)

        // If the agent navigated, re-inject banner so the final frame still shows it
        if (page.url() !== serverUrl + fp.initialUrl) {
          await injectBanner(
            page,
            `${intent.banner}  →  ${new URL(page.url()).pathname}`,
            intent.bannerColor
          )
        }

        const finalEval = await evaluateVerdict(
          page,
          fp,
          agentResult.stats,
          serverUrl,
          agentResult.agentVerdict
        )

        let verdict: 'passed' | 'bug' | 'tolerable' | 'error' = finalEval.verdict
        let detail = finalEval.detail
        if (agentResult.error) {
          verdict = 'error'
          detail = agentResult.error
        }
        if (verdict === 'bug') bugsFound++

        if (verdict === 'bug' || verdict === 'error') {
          await injectBanner(
            page,
            `🐛 BUG FOUND — ${intent.name}  ·  ${detail}`,
            '#dc2626'
          )
          await page.waitForTimeout(300)
        }

        // Capture freeze frame
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
          ordersCreated: finalEval.itemsCreated,
          durMs: Date.now() - t0,
          verdict,
          excess:
            finalEval.itemsCreated > 1 ? finalEval.itemsCreated - 1 : undefined,
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
    phaseId: fp.id,
    phaseIndex: fp.index,
    at: Date.now(),
  })

  return { bugsFound, controlForkId, intentsRun: intents.length }
}

// ---------- Top-level run ----------

export async function runForkExperiment(runId: string): Promise<void> {
  const server = await startBuggyServer(0)
  emit(runId, { type: 'run_started', runId, targetUrl: server.url, at: Date.now() })
  emit(runId, { type: 'initial_state_reached', cartSize: 0, at: Date.now() })

  const useLLM = hasApiKey()
  if (!useLLM) {
    console.log('[runner] OPENAI_API_KEY not set — falling back to hardcoded intents')
  }

  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    slowMo: SLOW_MO_MS,
  })

  // Fresh per-run map of "which fork was the control at each fork point"
  const controlByPoint = new Map<string, string>()

  try {
    let totalBugs = 0
    let totalForks = 0
    for (const fp of forkPoints) {
      const parentForkId = fp.chainsFrom ? controlByPoint.get(fp.chainsFrom) : undefined
      const result = await runForkPoint({
        runId,
        fp,
        browser,
        serverUrl: server.url,
        parentForkId,
        useLLM,
      })
      totalBugs += result.bugsFound
      totalForks += result.intentsRun
      if (result.controlForkId) controlByPoint.set(fp.id, result.controlForkId)
      await new Promise((r) => setTimeout(r, 600))
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
