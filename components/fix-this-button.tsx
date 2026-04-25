'use client'

import { useCallback, useState } from 'react'
import type { PatchAttemptStatus } from '../lib/patcher/types'

type Props = {
  runId: string
  forkId: string
  status?: PatchAttemptStatus
  prUrl?: string
  disabled?: boolean
}

const TERMINAL: ReadonlySet<PatchAttemptStatus> = new Set(['pr_opened', 'failed'])

export function FixThisButton({ runId, forkId, status, prUrl, disabled }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inFlight = !!status && !TERMINAL.has(status)
  const buttonDisabled = disabled || submitting || inFlight || status === 'pr_opened'

  const onClick = useCallback(async () => {
    if (buttonDisabled) return
    setError(null)
    setSubmitting(true)
    try {
      const r = await fetch(`/api/runs/${runId}/patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forkId }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j?.error ?? `HTTP ${r.status}`)
      }
    } catch (e) {
      setError((e as Error).message.slice(0, 120))
    } finally {
      setSubmitting(false)
    }
  }, [runId, forkId, buttonDisabled])

  if (status === 'pr_opened' && prUrl) {
    return (
      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          fontSize: 11,
          fontFamily: 'var(--font-mono), monospace',
          color: '#9affb1',
          background: '#0d1f12',
          border: '1px solid #1f4a2a',
          borderRadius: 4,
          textDecoration: 'none',
          letterSpacing: '0.04em',
        }}
      >
        view PR ↗
      </a>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        onClick={onClick}
        disabled={buttonDisabled}
        style={{
          padding: '6px 10px',
          fontSize: 11,
          fontFamily: 'var(--font-mono), monospace',
          color: buttonDisabled ? '#5a5f69' : '#ffd5d5',
          background: buttonDisabled ? '#0d0e11' : '#220d10',
          border: `1px solid ${buttonDisabled ? '#1d1f25' : '#5a1a1f'}`,
          borderRadius: 4,
          letterSpacing: '0.04em',
          cursor: buttonDisabled ? 'not-allowed' : 'pointer',
        }}
      >
        {submitting ? 'starting…' : inFlight ? `patcher: ${status}` : 'fix this →'}
      </button>
      {error && (
        <div
          style={{
            fontSize: 10.5,
            color: '#ffb4b4',
            fontFamily: 'var(--font-mono), monospace',
          }}
        >
          {error}
        </div>
      )}
    </div>
  )
}
