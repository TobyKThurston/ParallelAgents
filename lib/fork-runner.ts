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
  discoverForkPoints,
  type AgentAction,
  type BugKind,
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

// ---------- Browser config ----------

// Real desktop viewport — pages render like a normal full-screen webpage.
const VIEWPORT = { width: 1280, height: 800 }
const SLOW_MO_MS = 150
const MAX_AGENT_STEPS = 5

// Generic fallback used only when there's no API key or the planner fails.
// Web-agnostic — these descriptions don't assume any particular app.
const GENERIC_FALLBACK_INTENTS: GeneratedIntent[] = [
  {
    name: 'control-normal',
    banner: '🟢 CONTROL — complete the obvious flow',
    bannerColor: '#16a34a',
    description:
      'Act like a normal user: identify the most prominent call-to-action, fill any forms with realistic values, and click submit/save once. Verdict passed if you completed the flow without errors.',
  },
  {
    name: 'input-fuzz',
    banner: '🟠 INPUT FUZZ — break the inputs',
    bannerColor: '#ea580c',
    description:
      'Try adversarial values on every input: 999999, -5, empty strings, oversized text, special chars, emoji. Bug if any produces broken UI state (NaN/Infinity/negative totals/$undefined).',
  },
  {
    name: 'xss-probe',
    banner: '🟣 XSS — inject a payload',
    bannerColor: '#9333ea',
    description:
      'Find an input that gets reflected back to the user. Inject <img src=x onerror=alert(1)>, submit, navigate to wherever it shows. Bug if a JS dialog fires.',
  },
  {
    name: 'concurrency-stress',
    banner: '🔴 RACE — concurrent submit',
    bannerColor: '#dc2626',
    description:
      'Find a submit/save action and trigger it twice simultaneously via Promise.all of two fetch() calls. Bug if duplicate records or duplicate confirmations result.',
  },
]

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
        b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:99999;padding:0.5rem 0.8rem;background:${color};color:#fff;font-weight:700;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.5);letter-spacing:0.02em;font-family:system-ui;font-size:12px;pointer-events:none`
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

type SpawnRequest = {
  intents: { name: string; description: string; bannerColor?: string }[]
  reason: string
  /** A snapshot of the page state at the moment of spawn. */
  storageState: any
  /** The URL the parent had reached, sub-forks should resume here. */
  pageUrl: string
}

async function runAgentLoop(opts: {
  runId: string
  forkId: string
  intent: string
  page: Page
  ctx: BrowserContext
  canSpawn: boolean
}): Promise<{
  agentVerdict?: 'bug' | 'passed' | 'tolerable'
  agentReason?: string
  agentBugKind?: BugKind
  agentEvidence?: string
  steps: number
  stats: { dialogsSeen: number; httpErrors: number }
  error?: string
  spawn?: SpawnRequest
}> {
  const { runId, forkId, intent, page, ctx, canSpawn } = opts
  const stats = mkTracker(page)
  const history: AgentAction[] = []
  let agentVerdict: 'bug' | 'passed' | 'tolerable' | undefined
  let agentReason: string | undefined
  let agentBugKind: BugKind | undefined
  let agentEvidence: string | undefined
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
        intent: canSpawn
          ? intent
          : `${intent}\n\nNOTE: You cannot spawn sub-forks at this depth. Pursue the intent and return done.`,
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
    emit(runId, { type: 'agent_thought', forkId, step, action, frameB64: screenshotB64 })

    if (action.type === 'done') {
      agentVerdict = action.verdict
      agentReason = action.reason
      agentBugKind = action.bug_kind
      agentEvidence = action.evidence
      break
    }

    if (action.type === 'spawn') {
      if (!canSpawn) {
        // Sub-forks aren't allowed to spawn further; treat as done/tolerable.
        agentVerdict = 'tolerable'
        agentReason = `tried to spawn but already nested: ${action.reason.slice(0, 60)}`
        break
      }
      // Capture state and let the runner spin up children.
      const snapshot = await ctx.storageState().catch(() => null)
      if (!snapshot) {
        agentVerdict = 'tolerable'
        agentReason = `failed to snapshot for spawn`
        break
      }
      return {
        steps: step + 1,
        stats,
        agentReason: action.reason,
        spawn: {
          intents: action.intents.slice(0, 3),
          reason: action.reason,
          storageState: snapshot,
          pageUrl: page.url(),
        },
      }
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
    agentBugKind,
    agentEvidence,
    steps: step + (agentVerdict ? 1 : 0),
    stats,
  }
}

async function evaluateVerdict(
  page: Page,
  fp: ForkPoint,
  stats: { dialogsSeen: number; httpErrors: number },
  serverUrl: string,
  agentVerdict?: 'bug' | 'passed' | 'tolerable',
  agentBugKind?: BugKind,
  agentEvidence?: string
): Promise<{
  verdict: 'passed' | 'bug' | 'tolerable'
  detail: string
  itemsCreated: number
  bugKind?: BugKind
  bugEvidence?: string
}> {
  // Strong signals first.
  if (stats.dialogsSeen > 0) {
    return {
      verdict: 'bug',
      detail: `XSS dialog fired (${stats.dialogsSeen})`,
      bugKind: 'xss',
      bugEvidence: `${stats.dialogsSeen} JS dialog(s) fired during fork`,
      itemsCreated: 0,
    }
  }
  if (stats.httpErrors > 0) {
    return {
      verdict: 'bug',
      detail: `server 5xx fired (${stats.httpErrors}× — missing validation)`,
      bugKind: 'server-error',
      bugEvidence: `${stats.httpErrors} HTTP 5xx response(s) observed`,
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
      bugKind: 'duplicate-state',
      bugEvidence: `${itemsCreated} ${fp.countStateKey} created from a single fork (expected 1)`,
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
        return {
          verdict: 'bug',
          detail: `negative total: $${last.total}`,
          bugKind: 'broken-ui-state',
          bugEvidence: `last order total: $${last.total} (negative)`,
          itemsCreated,
        }
      }
      if (last && typeof last.total === 'number' && last.total === 0) {
        return {
          verdict: 'bug',
          detail: `coupon abuse: $0 total`,
          bugKind: 'validation-bypass',
          bugEvidence: `last order total: $0 (coupon accepted without floor)`,
          itemsCreated,
        }
      }
    } catch {}
  }

  if (agentVerdict === 'passed' && itemsCreated === 1) {
    return { verdict: 'passed', detail: `created 1 ${fp.countStateKey ?? 'item'}`, itemsCreated }
  }
  if (agentVerdict === 'bug') {
    // Trust the agent's bug claim if it provided a kind + evidence — otherwise downgrade.
    if (agentBugKind && agentEvidence) {
      return {
        verdict: 'bug',
        detail: agentEvidence,
        bugKind: agentBugKind,
        bugEvidence: agentEvidence,
        itemsCreated,
      }
    }
    return { verdict: 'tolerable', detail: 'agent claimed bug, no signal confirmed', itemsCreated }
  }
  if (itemsCreated === 1) {
    return { verdict: 'passed', detail: `created 1 ${fp.countStateKey ?? 'item'}`, itemsCreated }
  }
  return { verdict: 'tolerable', detail: 'no bug signal observed', itemsCreated }
}

// ---------- Single-intent runner (recursive — handles its own spawned children) ----------

const MAX_TOTAL_FORKS = 22
const MAX_SPAWN_DEPTH = 3 // depth 0 = top-level intent; chain can recurse 0 → 1 → 2 → 3

async function runSingleFork(opts: {
  runId: string
  forkId: string
  intent: { name: string; banner: string; bannerColor: string; description: string }
  browser: Browser
  serverUrl: string
  navigateTo: string // initial path, e.g. /issues/new
  storageState: any
  fp: ForkPoint
  depth: number
  totalForksRef: { count: number }
}): Promise<{
  verdict: 'passed' | 'bug' | 'tolerable' | 'error'
  detail: string
  itemsCreated: number
  bugsFoundIncludingDescendants: number
}> {
  const { runId, forkId, intent, browser, serverUrl, navigateTo, storageState, fp, depth, totalForksRef } = opts
  const t0 = Date.now()
  emit(runId, { type: 'fork_status', forkId, status: 'navigating' })

  const canSpawn =
    depth < MAX_SPAWN_DEPTH && totalForksRef.count < MAX_TOTAL_FORKS - 1

  const ctx = await browser.newContext({
    storageState,
    viewport: VIEWPORT,
  })
  ctx.setDefaultTimeout(8000)
  const page = await ctx.newPage()
  const stopStream = await startFramePoll(ctx, page, (b64) => {
    emit(runId, { type: 'fork_frame', forkId, data: b64 })
  })

  let verdict: 'passed' | 'bug' | 'tolerable' | 'error' = 'tolerable'
  let detail = ''
  let itemsCreated = 0
  let bugKind: BugKind | undefined
  let bugEvidence: string | undefined
  let spawnRequest: SpawnRequest | undefined
  let bugsHere = 0

  try {
    await page.goto(serverUrl + navigateTo)
    await injectBanner(page, intent.banner, intent.bannerColor)
    emit(runId, {
      type: 'fork_status',
      forkId,
      status: 'acting',
      detail: intent.description.slice(0, 80),
    })
    await page.waitForTimeout(400)

    const agentResult = await runAgentLoop({
      runId,
      forkId,
      intent: intent.description,
      page,
      ctx,
      canSpawn,
    })

    if (agentResult.spawn) {
      spawnRequest = agentResult.spawn
      // A spawning fork hands the verdict to its children — itself is the trunk.
      verdict = 'tolerable'
      detail = `spawned ${spawnRequest.intents.length} sub-forks · ${agentResult.agentReason ?? ''}`.slice(0, 140)
    } else {
      await page.waitForTimeout(400)
      if (page.url() !== serverUrl + navigateTo) {
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
        agentResult.agentVerdict,
        agentResult.agentBugKind,
        agentResult.agentEvidence
      )
      verdict = finalEval.verdict
      detail = finalEval.detail
      itemsCreated = finalEval.itemsCreated
      bugKind = finalEval.bugKind
      bugEvidence = finalEval.bugEvidence
      if (agentResult.error) {
        verdict = 'error'
        detail = agentResult.error
        bugKind = undefined
        bugEvidence = undefined
      }

      if (verdict === 'bug') bugsHere = 1
      if (verdict === 'bug' || verdict === 'error') {
        await injectBanner(
          page,
          `🐛 BUG FOUND — ${intent.name}  ·  ${detail}`,
          '#dc2626'
        )
        await page.waitForTimeout(300)
      }
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
      ordersCreated: itemsCreated,
      durMs: Date.now() - t0,
      verdict,
      bugKind,
      bugEvidence,
      excess: itemsCreated > 1 ? itemsCreated - 1 : undefined,
      bugDetail: detail,
    })
  } finally {
    await stopStream()
    await ctx.close().catch(() => {})
  }

  // Recursively spawn children if requested. Children themselves can spawn,
  // up to MAX_SPAWN_DEPTH and the global total-fork budget.
  let bugsInDescendants = 0
  if (spawnRequest) {
    const remaining = Math.max(0, MAX_TOTAL_FORKS - totalForksRef.count)
    const subIntents = spawnRequest.intents.slice(0, remaining)

    for (const si of subIntents) {
      emit(runId, {
        type: 'fork_created',
        forkId: `${forkId}.${si.name}`,
        strategyName: si.name,
        description: si.description.slice(0, 120),
        intent: 1,
        phaseId: fp.id,
        phaseIndex: fp.index,
        parentForkId: forkId,
      })
    }
    await new Promise((r) => setTimeout(r, 250))

    const subResults = await Promise.all(
      subIntents.map(async (si) => {
        totalForksRef.count++
        return runSingleFork({
          runId,
          forkId: `${forkId}.${si.name}`,
          intent: {
            name: si.name,
            banner: `↳ ${si.description.slice(0, 60)}`,
            bannerColor: si.bannerColor ?? '#3b82f6',
            description: si.description,
          },
          browser,
          serverUrl,
          navigateTo: new URL(spawnRequest!.pageUrl).pathname,
          storageState: spawnRequest!.storageState,
          fp,
          depth: depth + 1,
          totalForksRef,
        })
      })
    )

    bugsInDescendants = subResults.reduce(
      (s, r) => s + r.bugsFoundIncludingDescendants,
      0
    )
  }

  return {
    verdict,
    detail,
    itemsCreated,
    bugsFoundIncludingDescendants: bugsHere + bugsInDescendants,
  }
}

// ---------- Per-fork-point runner ----------

async function runForkPoint(opts: {
  runId: string
  fp: ForkPoint
  browser: Browser
  serverUrl: string
  parentForkId: string | undefined
  useLLM: boolean
  totalForksRef: { count: number }
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
      intents = GENERIC_FALLBACK_INTENTS
    }
  } else {
    intents = GENERIC_FALLBACK_INTENTS
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
      opts.totalForksRef.count++

      const result = await runSingleFork({
        runId,
        forkId,
        intent: {
          name: intent.name,
          banner: intent.banner,
          bannerColor: intent.bannerColor,
          description: intent.description,
        },
        browser,
        serverUrl,
        navigateTo: fp.initialUrl,
        storageState: forkState,
        fp,
        depth: 0,
        totalForksRef: opts.totalForksRef,
      })

      bugsFound += result.bugsFoundIncludingDescendants
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

export async function runForkExperiment(
  runId: string,
  targetUrl?: string
): Promise<void> {
  // Bring up the buggy demo server only if no external target was given.
  let serverUrl = targetUrl
  let serverStop: (() => Promise<void>) | undefined
  if (!serverUrl) {
    const server = await startBuggyServer(0)
    serverUrl = server.url
    serverStop = server.stop
  }
  emit(runId, { type: 'run_started', runId, targetUrl: serverUrl, at: Date.now() })
  emit(runId, { type: 'initial_state_reached', cartSize: 0, at: Date.now() })

  const useLLM = hasApiKey()
  if (!useLLM) {
    console.log('[runner] OPENAI_API_KEY not set — falling back to hardcoded intents')
  }

  const browser = await chromium.launch({
    headless: true,
    slowMo: SLOW_MO_MS,
  })

  // Discover fork points from the entry page itself. The LLM looks at what's
  // actually there (forms, mutations, inputs) and proposes 1-4 pages worth
  // probing. Falls back to the entry URL alone if discovery fails or no API key.
  let pointsToRun: ForkPoint[]
  if (useLLM) {
    let discovered: Awaited<ReturnType<typeof discoverForkPoints>> | undefined
    try {
      const reconCtx = await browser.newContext({ viewport: VIEWPORT })
      const reconPage = await reconCtx.newPage()
      await reconPage.goto(serverUrl)
      await reconPage.waitForTimeout(800)
      const buf = await reconPage.screenshot({ type: 'jpeg', quality: 60 })
      const dom = await reconPage.content().catch(() => '')
      await reconCtx.close().catch(() => {})

      discovered = await discoverForkPoints({
        entryUrl: serverUrl,
        domSnippet: dom,
        screenshotB64: buf.toString('base64'),
      })
    } catch (e: any) {
      console.log(`[runner] discover failed (${e?.message?.slice(0, 80) ?? 'unknown'}) — using entry page alone`)
    }

    if (discovered && discovered.length > 0) {
      pointsToRun = discovered.map((d, idx) => {
        // Normalize to a relative path so `serverUrl + initialUrl` works.
        let path = d.path
        if (path.startsWith('http')) {
          try {
            const u = new URL(path)
            path = (u.pathname || '/') + u.search + u.hash
          } catch {
            path = '/'
          }
        } else if (!path.startsWith('/')) {
          path = '/' + path
        }
        return {
          id: `fp-${d.name}`,
          index: idx,
          title: d.title,
          initialUrl: path,
          context: d.context,
          chainsFrom: idx > 0 ? `fp-${discovered![idx - 1].name}` : undefined,
        }
      })
    } else {
      pointsToRun = [
        {
          id: 'fp-entry',
          index: 0,
          title: `Entry · ${new URL(serverUrl).pathname || '/'}`,
          initialUrl: '/',
          context:
            'The entry page supplied by the user (or default buggy demo). Discovery did not return additional pages — probe this page directly.',
        },
      ]
    }
  } else {
    pointsToRun = [
      {
        id: 'fp-entry',
        index: 0,
        title: `Entry · ${new URL(serverUrl).pathname || '/'}`,
        initialUrl: '/',
        context: 'No API key — running a single fork point against the entry URL with hardcoded fallback intents.',
      },
    ]
  }

  // Fresh per-run map of "which fork was the control at each fork point"
  const controlByPoint = new Map<string, string>()
  const totalForksRef = { count: 0 }

  try {
    let totalBugs = 0
    for (const fp of pointsToRun) {
      const parentForkId = fp.chainsFrom ? controlByPoint.get(fp.chainsFrom) : undefined
      const result = await runForkPoint({
        runId,
        fp,
        browser,
        serverUrl,
        parentForkId,
        useLLM,
        totalForksRef,
      })
      totalBugs += result.bugsFound
      if (result.controlForkId) controlByPoint.set(fp.id, result.controlForkId)
      await new Promise((r) => setTimeout(r, 600))
    }

    emit(runId, {
      type: 'run_complete',
      runId,
      bugsFound: totalBugs,
      totalForks: totalForksRef.count,
      at: Date.now(),
    })
  } finally {
    await browser.close().catch(() => {})
    if (serverStop) await serverStop()
  }
}
