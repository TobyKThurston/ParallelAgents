import { NextResponse } from 'next/server'
import { createRun } from '../../../lib/runs'
import { runForkExperiment } from '../../../lib/fork-runner'
import type { RepoConfig } from '../../../lib/patcher/types'

export const runtime = 'nodejs'

function parseTargetRepo(raw: unknown): RepoConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (
    typeof r.owner !== 'string' ||
    typeof r.repo !== 'string' ||
    typeof r.baseBranch !== 'string' ||
    typeof r.installationId !== 'number'
  ) {
    return undefined
  }
  return {
    owner: r.owner,
    repo: r.repo,
    baseBranch: r.baseBranch,
    installationId: r.installationId,
    pathDenylist: Array.isArray(r.pathDenylist) ? (r.pathDenylist as string[]) : undefined,
    sanitizationFieldDenylist: Array.isArray(r.sanitizationFieldDenylist)
      ? (r.sanitizationFieldDenylist as string[])
      : undefined,
  }
}

export async function POST(req: Request) {
  let targetRepo: RepoConfig | undefined
  try {
    const body = await req.json().catch(() => null)
    targetRepo = parseTargetRepo(body?.targetRepo)
  } catch {
    // Empty/invalid body is fine — patcher just stays disabled for this run.
  }
  const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  createRun(id, { targetRepo })
  runForkExperiment(id).catch((err) => console.error(`[run ${id}] failed:`, err))
  return NextResponse.json({ runId: id })
}
