/**
 * POST /api/runs/[id]/patch — kick off the patcher for a specific bug fork.
 *
 * Returns 202 immediately. The patcher runs async; clients learn its status
 * via the existing SSE stream (patcher.* events).
 */

import { NextResponse } from 'next/server'
import { getRun } from '../../../../../lib/runs'
import { patchFromVerdict, resolveRepoConfig } from '../../../../../lib/patcher'

export const runtime = 'nodejs'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: runId } = await params
  const run = getRun(runId)
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 })

  if (!resolveRepoConfig(run)) {
    return NextResponse.json({ error: 'targetRepo not configured for this run' }, { status: 400 })
  }

  let forkId: string | undefined
  try {
    const body = (await req.json()) as { forkId?: string }
    forkId = body?.forkId
  } catch {}
  if (!forkId) return NextResponse.json({ error: 'forkId required' }, { status: 400 })

  // Don't double-patch
  if (run.patchAttempts[forkId] && run.patchAttempts[forkId].status !== 'failed') {
    return NextResponse.json({ error: 'patcher already running for this fork' }, { status: 409 })
  }

  patchFromVerdict(runId, forkId).catch((e) =>
    console.error(`[patcher ${runId}/${forkId}]`, e)
  )

  return NextResponse.json({ ok: true }, { status: 202 })
}
