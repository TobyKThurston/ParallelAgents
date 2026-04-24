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
