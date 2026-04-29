/**
 * Sandbox provider abstraction.
 *
 * The orchestrator never imports a concrete provider — it always goes through
 * `getDefaultSandboxProvider()` so swapping Vercel Sandbox for Daytona is a
 * one-line change in the env / this file.
 *
 * Spec for a SandboxHandle (whichever backend implements it):
 *   - it owns a working directory the agent can edit
 *   - runCommand returns the full stdout/stderr (not streaming) — agents are
 *     short-lived and each command's output is small
 *   - dispose tears down the sandbox unconditionally; idempotent
 */

export type SandboxSpawnOpts = {
  /** Used as a label only — useful in dashboards / logs. */
  label: string
  /** Optional wall-clock timeout in milliseconds (orchestrator passes 10min). */
  timeoutMs?: number
}

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SandboxHandle {
  /** Provider-specific id, surfaced in patcher.started for debugging. */
  readonly id: string
  /** Absolute path inside the sandbox where the orchestrator should clone the target repo. */
  readonly workdir: string
  runCommand(opts: { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string> }): Promise<CommandResult>
  writeFile(path: string, contents: string): Promise<void>
  readFile(path: string): Promise<string>
  dispose(): Promise<void>
}

export interface SandboxProvider {
  readonly name: string
  spawn(opts: SandboxSpawnOpts): Promise<SandboxHandle>
}

let cached: SandboxProvider | null = null

export async function getDefaultSandboxProvider(): Promise<SandboxProvider> {
  if (cached) return cached
  // Default: Vercel Sandbox. Swap to Daytona by setting PATCHER_SANDBOX=daytona.
  if (process.env.PATCHER_SANDBOX === 'daytona') {
    const { daytonaProvider } = await import('./daytona')
    cached = daytonaProvider
  } else {
    const { vercelProvider } = await import('./vercel')
    cached = vercelProvider
  }
  return cached
}
