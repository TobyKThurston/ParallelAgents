/**
 * Patcher orchestrator — turns a `bug` verdict into a PR.
 *
 * Flow (terminal states emit one of patcher.pr_opened / patcher.failed):
 *   1. resolve targetRepo (else fail)
 *   2. build PatcherContext from persisted run events
 *   3. spawn sandbox + clone target repo at baseBranch
 *   4. write /workspace/error_context.json
 *   5. install deps (best-effort, by lockfile detection)
 *   6. run Claude Agent SDK with cwd=repo, allowedTools restricted, hard
 *      maxTurns + wall-clock cap
 *   7. capture `git diff` — if empty, fail (agent didn't touch anything)
 *   8. push the branch via authed remote URL
 *   9. open the PR via the GitHub App token
 *
 * On any failure: emit patcher.failed with a short reason. Do NOT push partial
 * work. Do NOT retry.
 */

import { setPatchAttempt } from '../runs'
import { emit } from '../runs'
import { buildPatcherContext } from './context-builder'
import {
  authedRemoteUrl,
  createBranch,
  getBaseBranchSha,
  getInstallationToken,
  openPullRequest,
} from './github'
import { buildPrBody, buildPrTitle, buildPrompt } from './prompt'
import { getDefaultSandboxProvider, type SandboxHandle } from './sandbox'
import type { PatcherContext, PatcherResult } from './types'

const MAX_TURNS = 40
const WALL_CLOCK_MS = 10 * 60 * 1000
const PR_LABELS = ['auto-fix', 'needs-review']

function dryRun(): boolean {
  return process.env.PATCHER_DRY_RUN === '1'
}

function nowEvent(runId: string, forkId: string) {
  return { runId, forkId, at: Date.now() }
}

function fail(runId: string, forkId: string, reason: string): PatcherResult {
  emit(runId, { type: 'patcher.failed', ...nowEvent(runId, forkId), reason })
  setPatchAttempt(runId, forkId, {
    status: 'failed',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    failureReason: reason,
  })
  return { ok: false, reason }
}

export async function patchFromVerdict(runId: string, forkId: string): Promise<PatcherResult> {
  const startedAt = Date.now()
  setPatchAttempt(runId, forkId, { status: 'queued', startedAt })

  const built = buildPatcherContext(runId, forkId)
  if (!built.ok) return fail(runId, forkId, built.reason)
  const ctx = built.context

  emit(runId, { type: 'patcher.started', ...nowEvent(runId, forkId) })
  setPatchAttempt(runId, forkId, { status: 'sandbox_starting', startedAt })

  // ---- 1. Sandbox + clone ----
  let sandbox: SandboxHandle | null = null
  try {
    const provider = await getDefaultSandboxProvider()
    sandbox = await provider.spawn({
      label: `patcher:${runId}:${forkId}`,
      timeoutMs: WALL_CLOCK_MS,
    })
    emit(runId, {
      type: 'patcher.started',
      ...nowEvent(runId, forkId),
      sandboxId: sandbox.id,
    })

    const repoUrl = `https://github.com/${ctx.targetRepo.owner}/${ctx.targetRepo.repo}.git`
    const clone = await sandbox.runCommand({
      cmd: 'git',
      args: ['clone', '--depth', '1', '--branch', ctx.targetRepo.baseBranch, repoUrl, 'repo'],
      cwd: sandbox.workdir,
    })
    if (clone.exitCode !== 0) {
      return fail(runId, forkId, `git clone failed: ${clone.stderr.slice(0, 200)}`)
    }
    const repoDir = `${sandbox.workdir}/repo`

    // Configure git author for any commits the agent (or we) make.
    await sandbox.runCommand({
      cmd: 'git',
      args: ['-C', repoDir, 'config', 'user.name', 'parallel-agents-patcher'],
    })
    await sandbox.runCommand({
      cmd: 'git',
      args: ['-C', repoDir, 'config', 'user.email', 'patcher@parallel-agents.local'],
    })

    // ---- 2. Drop the error context bundle ----
    const prompt = buildPrompt(ctx)
    await sandbox.writeFile(`${sandbox.workdir}/error_context.json`, prompt.errorContextJson)

    // ---- 3. Install deps (best-effort) ----
    await installDeps(sandbox, repoDir)

    // ---- 4. Run the agent ----
    setPatchAttempt(runId, forkId, { status: 'agent_running', startedAt })
    const agentOk = await runAgentInSandbox({
      runId,
      forkId,
      ctx,
      sandbox,
      repoDir,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
    })
    if (!agentOk.ok) return fail(runId, forkId, agentOk.reason)

    // ---- 5. Capture diff ----
    const diffRes = await sandbox.runCommand({
      cmd: 'git',
      args: ['-C', repoDir, 'diff', '--stat'],
    })
    const diffSummary = diffRes.stdout.trim() || '(no diff stats)'
    const filesChanged = parseFilesChanged(diffSummary)
    if (filesChanged === 0) {
      return fail(runId, forkId, 'agent ran to completion but produced no diff')
    }
    emit(runId, {
      type: 'patcher.diff_ready',
      ...nowEvent(runId, forkId),
      diffSummary,
      filesChanged,
    })
    setPatchAttempt(runId, forkId, { status: 'diff_ready', startedAt })

    if (dryRun()) {
      emit(runId, {
        type: 'patcher.failed',
        ...nowEvent(runId, forkId),
        reason: 'dry-run mode: skipping push + PR (PATCHER_DRY_RUN=1)',
      })
      return { ok: false, reason: 'dry-run' }
    }

    // ---- 6. Commit + push + open PR ----
    setPatchAttempt(runId, forkId, { status: 'pushing', startedAt })
    const branchName = `auto-fix/run-${runId}-fork-${forkId.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const token = await getInstallationToken(ctx.targetRepo.installationId)

    const baseSha = await getBaseBranchSha(token, ctx.targetRepo, ctx.targetRepo.baseBranch)
    await createBranch(token, ctx.targetRepo, branchName, baseSha)

    // Stage everything the agent edited and commit.
    await sandbox.runCommand({ cmd: 'git', args: ['-C', repoDir, 'add', '-A'] })
    const commitRes = await sandbox.runCommand({
      cmd: 'git',
      args: ['-C', repoDir, 'commit', '-m', `auto-fix: ${ctx.intent.name}`],
    })
    if (commitRes.exitCode !== 0) {
      return fail(runId, forkId, `git commit failed: ${commitRes.stderr.slice(0, 200)}`)
    }

    // Push to the new branch.
    await sandbox.runCommand({
      cmd: 'git',
      args: ['-C', repoDir, 'checkout', '-B', branchName],
    })
    const remote = authedRemoteUrl(token, ctx.targetRepo)
    const push = await sandbox.runCommand({
      cmd: 'git',
      args: ['-C', repoDir, 'push', remote, `HEAD:${branchName}`],
    })
    if (push.exitCode !== 0) {
      return fail(runId, forkId, `git push failed: ${push.stderr.slice(0, 200)}`)
    }

    // Open PR.
    const runUrl = `${process.env.PARALLEL_AGENTS_BASE_URL ?? ''}/runs/${runId}`
    const pr = await openPullRequest(token, ctx.targetRepo, {
      branch: branchName,
      baseBranch: ctx.targetRepo.baseBranch,
      title: buildPrTitle(ctx),
      body: buildPrBody(ctx, { runUrl, diffSummary }),
      labels: PR_LABELS,
    })

    emit(runId, {
      type: 'patcher.pr_opened',
      ...nowEvent(runId, forkId),
      prUrl: pr.url,
      prNumber: pr.number,
      branchName,
    })
    setPatchAttempt(runId, forkId, {
      status: 'pr_opened',
      startedAt,
      finishedAt: Date.now(),
      prUrl: pr.url,
      prNumber: pr.number,
    })
    return { ok: true, prUrl: pr.url, prNumber: pr.number }
  } catch (e) {
    return fail(runId, forkId, `unhandled: ${(e as Error).message?.slice(0, 200) ?? 'unknown'}`)
  } finally {
    if (sandbox) await sandbox.dispose().catch(() => {})
  }
}

// ---- helpers ----

async function installDeps(sandbox: SandboxHandle, repoDir: string): Promise<void> {
  // Detect package manager by lockfile presence. Best-effort — failures don't
  // abort the patcher (the agent might not need deps to make a single-file fix).
  const ls = await sandbox.runCommand({ cmd: 'ls', args: ['-A', repoDir] })
  const files = new Set(ls.stdout.split(/\s+/))
  if (files.has('pnpm-lock.yaml')) {
    await sandbox.runCommand({ cmd: 'pnpm', args: ['install', '--prefer-offline'], cwd: repoDir })
  } else if (files.has('yarn.lock')) {
    await sandbox.runCommand({ cmd: 'yarn', args: ['install', '--frozen-lockfile'], cwd: repoDir })
  } else if (files.has('package-lock.json')) {
    await sandbox.runCommand({ cmd: 'npm', args: ['ci'], cwd: repoDir })
  }
}

function parseFilesChanged(diffStat: string): number {
  // git diff --stat last line: " 3 files changed, 12 insertions(+), 4 deletions(-)"
  const m = diffStat.match(/(\d+)\s+files?\s+changed/)
  return m ? parseInt(m[1], 10) : 0
}

/**
 * Run the Claude Agent CLI *inside* the sandbox (not in this Node process).
 *
 * Why: the SDK's `query()` JS function spawns a `claude` CLI subprocess
 * against a *local* cwd. The sandbox is a remote microVM, so we can't point
 * cwd at a path inside it from out here. The documented Vercel pattern is
 * to install the CLI in the sandbox and invoke it via runCommand.
 *
 * The CLI handles the agent loop, tool calls (Read/Edit/Bash/Glob/Grep),
 * and turn capping internally — we just wait for it to exit and stream
 * a digest of its output back as patcher.agent_message events.
 */
async function runAgentInSandbox(opts: {
  runId: string
  forkId: string
  ctx: PatcherContext
  sandbox: SandboxHandle
  repoDir: string
  systemPrompt: string
  userPrompt: string
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { runId, forkId, sandbox, repoDir, systemPrompt, userPrompt } = opts

  const gatewayKey = process.env.AI_GATEWAY_API_KEY
  if (!gatewayKey) {
    return { ok: false, reason: 'AI_GATEWAY_API_KEY not set — cannot run patcher agent' }
  }

  // Install the CLI in the sandbox (cached in image once Vercel Sandbox supports
  // pre-warmed images for this; for now, install per-spawn).
  const install = await sandbox.runCommand({
    cmd: 'npm',
    args: ['install', '-g', '@anthropic-ai/claude-code'],
  })
  if (install.exitCode !== 0) {
    return { ok: false, reason: `claude CLI install failed: ${install.stderr.slice(0, 200)}` }
  }

  // Combine system + user prompts into a single -p input.
  // The CLI accepts the prompt via stdin if -p is "-".
  const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`
  await sandbox.writeFile(`${sandbox.workdir}/prompt.txt`, fullPrompt)

  const result = await sandbox.runCommand({
    cmd: 'bash',
    args: [
      '-lc',
      `cat ${sandbox.workdir}/prompt.txt | claude -p --allowedTools "Read,Edit,Bash,Glob,Grep" --max-turns ${MAX_TURNS} --output-format stream-json`,
    ],
    cwd: repoDir,
    env: {
      ANTHROPIC_BASE_URL: 'https://ai-gateway.vercel.sh',
      ANTHROPIC_AUTH_TOKEN: gatewayKey,
      // Empty ANTHROPIC_API_KEY keeps the CLI from preferring the wrong creds.
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: process.env.PATCHER_MODEL ?? 'anthropic/claude-sonnet-4-5',
    },
  })

  // Stream-json output is one JSON object per line. Forward digests.
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let digest = trimmed.slice(0, 240)
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed?.type) digest = `[${parsed.type}] ${JSON.stringify(parsed).slice(0, 220)}`
    } catch {}
    emit(runId, {
      type: 'patcher.agent_message',
      ...nowEvent(runId, forkId),
      message: digest,
    })
  }

  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `claude CLI exit ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
    }
  }
  return { ok: true }
}
