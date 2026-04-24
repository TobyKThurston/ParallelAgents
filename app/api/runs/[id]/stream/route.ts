import { getRun, subscribe } from '../../../../../lib/runs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const run = getRun(id)
  if (!run) {
    return new Response('run not found', { status: 404 })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          // controller already closed
        }
      }

      // Replay history first so late subscribers catch up
      for (const evt of run.events) send(evt)

      if (run.complete) {
        controller.close()
        return
      }

      const unsubscribe = subscribe(id, (evt) => {
        send(evt)
        if (evt.type === 'run_complete') {
          setTimeout(() => {
            unsubscribe()
            try {
              controller.close()
            } catch {
              /* already closed */
            }
          }, 100)
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
