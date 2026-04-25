'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'

export default function Home() {
  const router = useRouter()
  const [starting, setStarting] = useState(false)

  const startRun = useCallback(async () => {
    if (starting) return
    setStarting(true)
    try {
      const res = await fetch('/api/runs', { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { runId } = (await res.json()) as { runId: string }
      router.push(`/runs/${runId}`)
    } catch (e) {
      setStarting(false)
      alert(`failed to start run: ${e}`)
    }
  }, [router, starting])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Enter') return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.metaKey || e.ctrlKey || document.activeElement === document.body) {
        e.preventDefault()
        startRun()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [startRun])

  return (
    <div className="landing">
      <div className="ambient-grid" aria-hidden="true" />

      <nav className="top-nav">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path
                d="M2 8 L7 8 M7 8 L13 3 M7 8 L13 8 M7 8 L13 13"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <strong>Parallel Agents</strong>
        </div>
        <div className="env-chip">
          <span className="dot" /> ready
        </div>
      </nav>

      <main className="hero">
        <h1>
          Four browsers,<br />
          one shared state,<br />
          <em>every</em> reality at once.
        </h1>

        <ForkDiagram />

        <p className="tagline">snapshot · fork · diff</p>

        <div className="cta-row">
          <button className="begin-btn" onClick={startRun} disabled={starting}>
            {starting ? (
              <>
                <span className="spinner" /> spawning…
              </>
            ) : (
              <>
                Start <span className="arrow">→</span>
              </>
            )}
          </button>
          <span className="kbd-hint">
            <kbd>↵</kbd>
          </span>
        </div>
      </main>

      <footer className="landing-footer">
        <div className="built-with">
          <span className="bw-item">vercel sandbox</span>
          <span className="bw-sep">·</span>
          <span className="bw-item">playwright</span>
          <span className="bw-sep">·</span>
          <span className="bw-item">openai</span>
          <span className="bw-sep">·</span>
          <span className="bw-item">chromium</span>
        </div>
      </footer>
    </div>
  )
}

function ForkDiagram() {
  return (
    <svg
      viewBox="0 0 380 260"
      className="fork-diagram"
      role="img"
      aria-label="One snapshot fans out into four parallel forks"
    >
      <g className="fork-origin">
        <rect x="6" y="120" width="44" height="20" rx="4" />
        <text x="28" y="134" textAnchor="middle">snap</text>
      </g>

      <path d="M 50 130 L 152 130" className="fork-trunk" />
      <circle cx="152" cy="130" r="3" className="fork-split-node" />

      <path d="M 152 130 C 200 130, 210 30, 268 30" className="fork-branch b1" />
      <path d="M 152 130 C 200 130, 210 96, 268 96" className="fork-branch b2" />
      <path d="M 152 130 C 200 130, 210 164, 268 164" className="fork-branch b3" />
      <path d="M 152 130 C 200 130, 210 230, 268 230" className="fork-branch b4" />

      <g className="fork-tip t1">
        <circle cx="268" cy="30" r="5" />
        <text x="282" y="34">control</text>
      </g>
      <g className="fork-tip t2">
        <circle cx="268" cy="96" r="5" />
        <text x="282" y="100">race</text>
      </g>
      <g className="fork-tip t3">
        <circle cx="268" cy="164" r="5" />
        <text x="282" y="168">validation</text>
      </g>
      <g className="fork-tip t4">
        <circle cx="268" cy="230" r="5" />
        <text x="282" y="234">injection</text>
      </g>
    </svg>
  )
}
