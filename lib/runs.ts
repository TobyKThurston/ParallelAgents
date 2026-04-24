/**
 * In-memory run store. Each run has a replay log of events (so SSE clients that
 * connect late catch up) plus a pub-sub channel for live subscribers. Stored on
 * globalThis so Next.js hot-reload in dev doesn't nuke live runs.
 */

import { EventEmitter } from 'node:events'
import type { RunEvent } from './events'

type Run = {
  id: string
  events: RunEvent[]
  emitter: EventEmitter
  complete: boolean
}

type RunStore = Map<string, Run>

declare global {

  var __runStore: RunStore | undefined
}

const store: RunStore = globalThis.__runStore ?? new Map<string, Run>()
if (!globalThis.__runStore) globalThis.__runStore = store

export function createRun(id: string): Run {
  const run: Run = { id, events: [], emitter: new EventEmitter(), complete: false }
  run.emitter.setMaxListeners(50)
  store.set(id, run)
  return run
}

export function getRun(id: string): Run | undefined {
  return store.get(id)
}

export function emit(runId: string, event: RunEvent) {
  const run = store.get(runId)
  if (!run) return
  // Don't persist high-volume screencast frames in the replay log — they'd
  // bloat memory and slow down late subscribers. Only `final: true` frames
  // are persisted so the frozen bug state survives reconnects.
  const persist = event.type !== 'fork_frame' || event.final === true
  if (persist) run.events.push(event)
  run.emitter.emit('event', event)
  if (event.type === 'run_complete') {
    run.complete = true
  }
}

export function subscribe(runId: string, handler: (e: RunEvent) => void): () => void {
  const run = store.get(runId)
  if (!run) return () => {}
  run.emitter.on('event', handler)
  return () => run.emitter.off('event', handler)
}
