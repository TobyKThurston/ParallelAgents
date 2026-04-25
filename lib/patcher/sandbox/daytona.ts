/**
 * Daytona sandbox provider — stub.
 *
 * Selected when PATCHER_SANDBOX=daytona. Throws on spawn() until implemented;
 * the orchestrator reports this back as a clean patcher.failed event.
 *
 * The integration shape (when needed):
 *   - import { Daytona } from '@daytonaio/sdk' (add to package.json)
 *   - const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
 *   - const ws = await daytona.workspace.create({ image: 'node:22' })
 *   - ws.process.executeCommand(...) / ws.fs.uploadFile(...) / ws.delete()
 *
 * Reference: https://www.daytona.io/docs/en/guides/claude/claude-agent-sdk-interactive-terminal-sandbox/
 */

import type { SandboxProvider, SandboxHandle, SandboxSpawnOpts } from './index'

export const daytonaProvider: SandboxProvider = {
  name: 'daytona',
  async spawn(_opts: SandboxSpawnOpts): Promise<SandboxHandle> {
    throw new Error(
      'Daytona sandbox provider is not implemented yet. Unset PATCHER_SANDBOX or set it to "vercel".'
    )
  },
}
