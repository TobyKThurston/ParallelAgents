export type ForkStatus = 'pending' | 'navigating' | 'acting' | 'passed' | 'bug' | 'tolerable' | 'error'

export type BugKind =
  | 'xss'
  | 'server-error'
  | 'validation-bypass'
  | 'broken-ui-state'
  | 'duplicate-state'
  | 'auth-bypass'
  | 'data-leak'
  | 'crash'
  | 'other'

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
      /** Screenshot the agent saw at the START of this step, before its action ran. Used for replay. */
      frameB64?: string
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
        | {
            type: 'done'
            verdict: 'bug' | 'passed' | 'tolerable'
            reason: string
            bug_kind?: BugKind
            evidence?: string
          }
    }
  | {
      type: 'fork_complete'
      forkId: string
      ordersCreated: number
      durMs: number
      verdict: 'passed' | 'bug' | 'tolerable' | 'error'
      bugKind?: BugKind
      bugEvidence?: string
      excess?: number
      error?: string
      bugDetail?: string
    }
  | { type: 'run_complete'; runId: string; bugsFound: number; totalForks: number; at: number }
