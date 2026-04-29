/**
 * Shared types for the patcher subsystem.
 *
 * Kept separate from the orchestrator/sandbox/github modules so other parts
 * of the codebase (lib/runs.ts, the API route, the UI) can import the type
 * surface without dragging in heavy dependencies.
 */

/** Per-run target repo config the user supplies when starting a probe. */
export type RepoConfig = {
  owner: string
  repo: string
  baseBranch: string
  /** GitHub App installation id for this repo. */
  installationId: number
  /**
   * Optional path denylist on top of the patcher defaults
   * (.github/workflows, .env*, infra/**, deploy/**, *secret*, *credential*).
   */
  pathDenylist?: string[]
  /**
   * Optional extra field-name patterns to strip from request/response bodies
   * before they reach the agent (default: password, secret, token, apiKey, ssn).
   */
  sanitizationFieldDenylist?: string[]
}

export type PatchAttemptStatus =
  | 'queued'
  | 'sandbox_starting'
  | 'agent_running'
  | 'diff_ready'
  | 'pushing'
  | 'pr_opened'
  | 'failed'

export type PatchAttempt = {
  status: PatchAttemptStatus
  startedAt: number
  finishedAt?: number
  prUrl?: string
  prNumber?: number
  /** Short reason set when status === 'failed'. */
  failureReason?: string
}

/** Fork-level data the orchestrator passes to the agent. */
export type PatcherContext = {
  runId: string
  forkId: string

  /** The intent the probe agent was pursuing on this fork. */
  intent: {
    name: string
    description: string
  }
  verdict: 'bug'
  verdictReasoning: string

  /** The probe agent's action history (the reproduction). */
  reproduction: Array<Record<string, unknown>>

  /** What the runner's heuristics decided about the fork (XSS dialog fired, 5xx, race count). */
  bugDetail: string

  /**
   * Per-fork network errors. Empty in v1 (the runner doesn't capture these yet).
   * Populate once fork-runner.ts grows network-error capture.
   */
  networkErrors: Array<{
    method: string
    url: string
    status: number
    requestBody?: unknown
    responseBody?: unknown
    timing: { startedAt: number; durationMs: number }
  }>

  /** Per-fork console errors. Empty in v1 for the same reason. */
  consoleErrors: string[]

  targetRepo: RepoConfig
  /** The URL the probe was hitting — useful for the patcher to grep route handlers. */
  targetUrl: string
}

export type PatcherResult =
  | { ok: true; prUrl: string; prNumber: number }
  | { ok: false; reason: string }
