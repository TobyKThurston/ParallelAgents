/**
 * Vercel Sandbox provider.
 *
 * Auth comes from one of:
 *   - VERCEL_OIDC_TOKEN (preferred — set by `vercel env pull` once the project is linked)
 *   - the team/project/token trio (VERCEL_TEAM_ID + VERCEL_PROJECT_ID + VERCEL_TOKEN)
 *
 * The Sandbox SDK reads these automatically; we don't pass them explicitly.
 *
 * Default network policy: deny everything except the registries / APIs the
 * agent legitimately needs. Tweak this in spawn() rather than per-command so
 * misconfigured agent code can't accidentally exfiltrate.
 */

import { Sandbox } from '@vercel/sandbox'
import type {
  CommandResult,
  SandboxHandle,
  SandboxProvider,
  SandboxSpawnOpts,
} from './index'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const WORKDIR = '/vercel/sandbox'

const ALLOWED_DOMAINS = [
  // Anthropic via Vercel AI Gateway
  'ai-gateway.vercel.sh',
  // GitHub
  'api.github.com',
  'github.com',
  'codeload.github.com',
  // Common package registries
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
]

class VercelSandboxHandle implements SandboxHandle {
  readonly id: string
  readonly workdir = WORKDIR

  constructor(private sandbox: Sandbox) {
    this.id = sandbox.sandboxId
  }

  async runCommand(opts: { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string> }): Promise<CommandResult> {
    const finished = await this.sandbox.runCommand({
      cmd: opts.cmd,
      args: opts.args,
      cwd: opts.cwd ?? this.workdir,
      env: opts.env,
    })
    const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()])
    return { exitCode: finished.exitCode, stdout, stderr }
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await this.sandbox.writeFiles([{ path, content: contents }])
  }

  async readFile(path: string): Promise<string> {
    const buf = await this.sandbox.readFileToBuffer({ path })
    if (!buf) throw new Error(`readFile: ${path} not found`)
    return buf.toString('utf8')
  }

  async dispose(): Promise<void> {
    try {
      await this.sandbox.stop()
    } catch {
      // best-effort teardown — sandboxes auto-expire on timeout regardless
    }
  }
}

export const vercelProvider: SandboxProvider = {
  name: 'vercel',
  async spawn(opts: SandboxSpawnOpts): Promise<SandboxHandle> {
    const sandbox = await Sandbox.create({
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      networkPolicy: { allow: ALLOWED_DOMAINS },
    })
    return new VercelSandboxHandle(sandbox)
  },
}
