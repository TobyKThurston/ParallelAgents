'use client'

import type { PatchAttemptStatus } from '../lib/patcher/types'

export type PatcherView = {
  status: PatchAttemptStatus
  prUrl?: string
  prNumber?: number
  diffSummary?: string
  filesChanged?: number
  failureReason?: string
  /** Last few agent message digests, newest last. */
  messages: string[]
}

const STATUS_LABEL: Record<PatchAttemptStatus, string> = {
  queued: 'queued',
  sandbox_starting: 'starting sandbox',
  agent_running: 'agent working',
  diff_ready: 'diff ready',
  pushing: 'pushing branch',
  pr_opened: 'PR opened',
  failed: 'failed',
}

export function PatcherStatus({ view }: { view: PatcherView }) {
  const accent =
    view.status === 'failed' ? '#ffb4b4'
    : view.status === 'pr_opened' ? '#9affb1'
    : '#7aa7ff'

  return (
    <div
      style={{
        marginTop: 10,
        padding: '8px 10px',
        border: `1px solid ${view.status === 'failed' ? '#3a1517' : '#1d1f25'}`,
        background: '#0a0b0d',
        borderRadius: 4,
        fontFamily: 'var(--font-mono), monospace',
        fontSize: 11,
        color: '#cbd0d9',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          color: '#5a5f69',
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          fontSize: 10,
          marginBottom: 6,
        }}
      >
        <span>patcher</span>
        <span style={{ color: accent }}>{STATUS_LABEL[view.status]}</span>
      </div>

      {view.diffSummary && (
        <pre
          style={{
            margin: 0,
            padding: '6px 8px',
            background: '#06070a',
            border: '1px solid #1d1f25',
            borderRadius: 3,
            color: '#9ea3ad',
            fontSize: 10.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {view.diffSummary}
        </pre>
      )}

      {view.failureReason && (
        <div style={{ color: '#ffb4b4', marginTop: 6 }}>{view.failureReason}</div>
      )}

      {view.messages.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {view.messages.slice(-4).map((m, i) => (
            <div
              key={i}
              style={{
                color: '#7e848e',
                fontSize: 10,
                wordBreak: 'break-word',
              }}
            >
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
