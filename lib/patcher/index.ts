/**
 * Public entry point for the patcher subsystem.
 *
 * Other parts of the app (the API route, the UI) only ever import from here.
 * The orchestrator/sandbox/github internals stay encapsulated.
 */

export type {
  RepoConfig,
  PatchAttempt,
  PatchAttemptStatus,
  PatcherContext,
  PatcherResult,
} from './types'

export { resolveRepoConfig } from './repo-config'

/**
 * Stub for the patcher entry point. Replaced by the real orchestrator in commit 7.
 * Throws so a wired-up UI surfaces a clear error if it lands ahead of the orchestrator.
 */
export async function patchFromVerdict(_runId: string, _forkId: string): Promise<never> {
  throw new Error('patchFromVerdict: orchestrator not yet wired (commit 7)')
}
