/**
 * GET /api/runs/[id]/meta — small read endpoint the UI calls on mount.
 *
 * Returns booleans + identifiers, never the App installation token.
 */

import { NextResponse } from 'next/server'
import { getRun } from '../../../../../lib/runs'

export const runtime = 'nodejs'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const run = getRun(id)
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 })

  const target = run.targetRepo
  return NextResponse.json({
    targetRepoConfigured: !!target,
    targetRepoSlug: target ? `${target.owner}/${target.repo}` : null,
    targetBaseBranch: target?.baseBranch ?? null,
    patchAttempts: run.patchAttempts,
  })
}
