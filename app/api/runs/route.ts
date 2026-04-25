import { NextResponse } from 'next/server'
import { createRun } from '../../../lib/runs'
import { runForkExperiment } from '../../../lib/fork-runner'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  let targetUrl: string | undefined
  try {
    const body = (await req.json().catch(() => null)) as { targetUrl?: string } | null
    const t = body?.targetUrl?.trim()
    if (t) targetUrl = t
  } catch {}

  const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  createRun(id)
  runForkExperiment(id, targetUrl).catch((err) => console.error(`[run ${id}] failed:`, err))
  return NextResponse.json({ runId: id })
}
