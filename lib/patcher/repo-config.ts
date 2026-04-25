/**
 * The (a) → (b) seam.
 *
 * v1 (now): the run already carries its own targetRepo, so resolution is
 * trivial.
 *
 * v2 (future): swap this body for a registry lookup keyed on run.targetUrl
 * (or some stable identity), so users don't have to send targetRepo with
 * every probe. The rest of the patcher imports through this function and
 * doesn't need to know which scheme is in use.
 */

import type { Run } from '../runs'
import type { RepoConfig } from './types'

export function resolveRepoConfig(run: Run): RepoConfig | null {
  return run.targetRepo ?? null
}
