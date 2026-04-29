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
export { patchFromVerdict } from './orchestrator'
