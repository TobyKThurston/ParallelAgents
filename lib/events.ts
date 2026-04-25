export type ForkStatus = 'pending' | 'navigating' | 'acting' | 'passed' | 'bug' | 'tolerable' | 'error'

export type RunEvent =
  | { type: 'run_started'; runId: string; targetUrl: string; at: number }
  | { type: 'initial_state_reached'; cartSize: number; at: number }
  | { type: 'storage_snapshotted'; origins: number; at: number }
  | { type: 'phase_started'; phaseId: string; phaseTitle: string; phaseIndex: number; at: number }
  | { type: 'phase_complete'; phaseId: string; phaseIndex: number; at: number }
  | {
      type: 'fork_created'
      forkId: string
      strategyName: string
      description: string
      intent: number
      phaseId?: string
      phaseIndex?: number
      parentForkId?: string
    }
  | { type: 'fork_status'; forkId: string; status: ForkStatus; detail?: string }
  | { type: 'fork_frame'; forkId: string; data: string; final?: boolean }
  | {
      type: 'agent_thought'
      forkId: string
      step: number
      action:
        | { type: 'click'; selector: string; reason: string }
        | { type: 'fill'; selector: string; value: string; reason: string }
        | { type: 'press'; selector: string; key: string; reason: string }
        | { type: 'eval'; code: string; reason: string }
        | {
            type: 'spawn'
            intents: { name: string; description: string; bannerColor?: string }[]
            reason: string
          }
        | { type: 'done'; verdict: 'bug' | 'passed' | 'tolerable'; reason: string }
    }
  | {
      type: 'fork_complete'
      forkId: string
      ordersCreated: number
      durMs: number
      verdict: 'passed' | 'bug' | 'tolerable' | 'error'
      excess?: number
      error?: string
      bugDetail?: string
    }
  | { type: 'run_complete'; runId: string; bugsFound: number; totalForks: number; at: number }
