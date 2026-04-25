/**
 * Build the PatcherContext bundle the agent will work from.
 *
 * Sources today (v1):
 *   - the run's persisted events (agent_thought, fork_complete, fork_status)
 *   - the run's targetRepo
 *   - the buggy server's URL (carried on run_started)
 *
 * Not yet captured (left as empty arrays so the bundle shape is stable):
 *   - per-fork networkErrors — would require fork-runner to attach a
 *     page.on('response') tap and persist failed/5xx requests
 *   - per-fork consoleErrors — page.on('console') tap
 *
 * When fork-runner grows that capture, populate networkErrors/consoleErrors
 * here from the same persisted events.
 */

import { getRun } from '../runs'
import { resolveRepoConfig } from './repo-config'
import { sanitizeBody } from './sanitize'
import type { PatcherContext } from './types'

type BuildResult = { ok: true; context: PatcherContext } | { ok: false; reason: string }

export function buildPatcherContext(runId: string, forkId: string): BuildResult {
  const run = getRun(runId)
  if (!run) return { ok: false, reason: `run ${runId} not found` }
  const repo = resolveRepoConfig(run)
  if (!repo) return { ok: false, reason: 'targetRepo not configured for this run' }

  const targetUrl =
    (run.events.find((e) => e.type === 'run_started') as Extract<typeof run.events[number], { type: 'run_started' }> | undefined)?.targetUrl ?? ''

  const forkCreated = run.events.find(
    (e) => e.type === 'fork_created' && e.forkId === forkId
  ) as Extract<typeof run.events[number], { type: 'fork_created' }> | undefined
  if (!forkCreated) return { ok: false, reason: `fork ${forkId} not found in run` }

  const forkComplete = run.events.find(
    (e) => e.type === 'fork_complete' && e.forkId === forkId
  ) as Extract<typeof run.events[number], { type: 'fork_complete' }> | undefined
  if (!forkComplete) return { ok: false, reason: `fork ${forkId} has not completed yet` }
  if (forkComplete.verdict !== 'bug') {
    return { ok: false, reason: `fork ${forkId} verdict is ${forkComplete.verdict}, not bug` }
  }

  const thoughts = run.events.filter(
    (e) => e.type === 'agent_thought' && e.forkId === forkId
  ) as Array<Extract<typeof run.events[number], { type: 'agent_thought' }>>

  const reproduction = thoughts.map((t) => sanitizeBody(t.action) as Record<string, unknown>)

  // The probe agent's last 'done' verdict reasoning, if it returned one.
  const lastDone = [...thoughts].reverse().find((t) => t.action.type === 'done')
  const verdictReasoning =
    (lastDone?.action.type === 'done' && lastDone.action.reason) || forkComplete.bugDetail || ''

  return {
    ok: true,
    context: {
      runId,
      forkId,
      intent: {
        name: forkCreated.strategyName,
        description: forkCreated.description,
      },
      verdict: 'bug',
      verdictReasoning,
      reproduction,
      bugDetail: forkComplete.bugDetail ?? '',
      networkErrors: [],
      consoleErrors: [],
      targetRepo: repo,
      targetUrl,
    },
  }
}
