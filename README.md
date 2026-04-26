# vibe check

> One snapshot, a swarm of agents, every bug at once.

A vision-driven adversarial QA tool. Point it at a SaaS app, and a swarm of GPT-4o-mini agents drive headless Chromium browsers in parallel — each pursuing a different attack intent (XSS, race conditions, validation bypass, crashes) — and stream their findings into a live tree UI as they fork.

Built in 48 hours for the Vercel × Parallel Agents hackathon.

---

## The idea

QA is sequential: one tester, one path, one bug at a time. Real apps fail in branching ways — the same form crashes on empty input, accepts negative numbers, double-submits, *and* reflects XSS, depending on which path you take.

**vibe check** parallelizes the search. At every interesting page (a "fork point"), an LLM looks at the live screenshot + DOM, generates 2–5 adversarial intents tailored to what's actually on screen, and spawns an isolated Chromium context per intent. Each fork runs its own vision-loop agent: screenshot → reason → click/fill/eval → repeat, until a verdict (`bug` / `passed` / `tolerable`) is returned. The "control" branch that completes the happy flow chains into the next fork point, so attack surfaces compound rather than reset.

The whole tree streams to the browser over SSE while it runs.

---

## How it works

```
ROOT (snapshot of app state)
├── fp1.intent-A   xss-probe          → bug
├── fp1.intent-B   control-normal     → passed ─┐
├── fp1.intent-C   concurrency-stress → bug     │
└── fp1.intent-D   input-fuzz         → bug     │
                                                ▼
                                ┌── fp2.intent-A
                                ├── fp2.intent-B
                                └── fp2.intent-C
```

1. **Discovery.** An LLM planner inspects the target and proposes fork points (form pages, settings, billing, etc.). For known demo targets, a pinned catalog skips discovery to avoid hallucinated 404 paths.
2. **Intent generation.** At each fork point, GPT-4o-mini sees a real screenshot + compact DOM and produces 2–5 intents grounded in what's visible — not a fixed taxonomy.
3. **Per-fork agent loop.** Each intent gets its own `BrowserContext`. The agent calls a tool-bound model that returns one of `click | fill | press | eval | done`, capped at 5 steps. CDP `captureScreenshot` polling streams frames into the UI.
4. **Verdict aggregation.** A small bug catalog (XSS, server-error, validation-bypass, broken-ui-state, duplicate-state, auth-bypass, data-leak, crash) is enforced via OpenAI tool-call schemas, so verdicts arrive as typed structured data.
5. **Live tree.** React Flow renders forks as they're created. Frames update in place. Each terminal node carries its evidence + a one-click "Claude-fix prompt" tailored to the bug.

---

## Stack

- **Next.js 16 (App Router) + React 19** — UI, API routes, Server Components
- **Playwright + @sparticuz/chromium** — headless browser per fork
- **OpenAI** — `gpt-4o-mini` vision + function-calling for the agent loop and intent planner
- **Server-Sent Events** — frame and event streaming to the tree UI
- **React Flow (`@xyflow/react`)** — fork-tree layout
- **Zod** — runtime validation of LLM-returned actions
- **Vercel Sandbox** — for sandboxed dev/preview targets
- **TypeScript, strict mode**

---

## Engineering details worth a look

- **`lib/fork-runner.ts`** — orchestrates the multi-fork-point chain, pinned catalogs for known demo hosts, and per-fork context isolation.
- **`lib/agent.ts`** — the vision agent loop. Tool-bound action schema means the model can never return free-form text the executor doesn't understand.
- **`lib/runs.ts`** — in-memory pub/sub run store with a replay log, so SSE clients that connect late get the full event history before live tail. Stored on `globalThis` to survive Next.js dev hot-reloads.
- **`lib/buggy-cart-server.ts`** — "Helix," a deliberately-buggy multi-page SaaS (issues / billing / settings) with 9 planted bugs across 5 categories. Doubles as a smoke target and a demo backdrop.
- **`components/fork-tree.tsx`** — live tree UI with capped row heights, inline bug evidence, and the Claude-fix prompt panel.
- **`scripts/fork-proof/run.ts`** — headless smoke harness that exercises the full fork-runner without the UI.

---

## Run locally

```bash
pnpm install
echo "OPENAI_API_KEY=sk-..." > .env.local
pnpm dev
```

Open http://localhost:3000, paste any URL (or leave blank to attack the built-in Helix app), and hit **Start**.

```bash
pnpm fork-proof          # headless end-to-end smoke
pnpm helix               # serve the buggy demo target standalone
pnpm m1:smoke            # M1 sandbox smoke
```

---

## Project layout

```
app/
  page.tsx               landing + start CTA
  runs/[id]/page.tsx     live run view
  api/runs/route.ts      POST /api/runs (kicks off a run)
  api/runs/[id]/...      SSE stream + status endpoints
components/
  fork-tree.tsx          live tree UI (React Flow)
lib/
  fork-runner.ts         multi-fork orchestrator
  agent.ts               vision-loop adversarial agent
  buggy-cart-server.ts   the Helix demo target
  runs.ts                in-memory run store + pub/sub
  events.ts              typed run-event protocol
  chromium-launcher.ts   sparticuz/chromium wiring
scripts/
  fork-proof/run.ts      headless smoke
  helix.ts               serve Helix standalone
slides/                  demo deck
```

---

## What's intentionally not here

This is a hackathon prototype. The run store is in-memory; there's no auth, no persistence, no rate limiting on the OpenAI calls, and the agent step cap is hardcoded. It's tuned for demos, not for production scale. The interesting parts are the agent loop, the fork topology, and the streaming protocol — those are all production-shaped.

---

## Credits

Built by Toby Thurston for the Vercel × Parallel Agents hackathon, 2026.
