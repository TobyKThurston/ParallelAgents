import { NextResponse } from 'next/server'
import { createRun } from '../../../lib/runs'
import { runForkExperiment } from '../../../lib/fork-runner'

export const runtime = 'nodejs'

export async function POST() {
  const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  createRun(id)
  runForkExperiment(id).catch((err) => console.error(`[run ${id}] failed:`, err))
  return NextResponse.json({ runId: id })
}
