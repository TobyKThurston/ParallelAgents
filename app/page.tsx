'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'

const STRATEGIES = [
  {
    name: 'control-normal-submit',
    color: '#7ddc9c',
    kind: 'baseline',
    blurb: 'Fills the form correctly, submits once. Sets the expected order count.',
  },
  {
    name: 'race-double-submit',
    color: '#ff6b6b',
    kind: 'concurrency',
    blurb: 'Fires two submits back-to-back. Probes for missing idempotency.',
  },
  {
    name: 'validation-missing-email',
    color: '#fbbf24',
    kind: 'input',
    blurb: 'Omits a required field. Checks that the server still enforces it.',
  },
  {
    name: 'injection-xss-in-name',
    color: '#c9a8ff',
    kind: 'escaping',
    blurb: 'Injects a payload into name. Looks for unescaped reflection on success.',
  },
]

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
      <nav className="top-nav">
        <div className="brand">
          ◆ <strong>Parallel Agents</strong>
        </div>
        <div className="env-chip">
          <span className="dot" /> ready · local · v0.1
        </div>
      </nav>

      <main className="landing-main">
        <section className="brief">
          <div className="section-label">01 · Brief</div>
          <h1>
            Four browsers, one shared state,<br />
            <em>every</em> reality at once.
          </h1>
          <p>
            A normal test walks one path. Parallel Agents warms a real browser
            to a critical step, snapshots its state, then forks that snapshot
            across four Chromium windows &mdash; each carrying a different
            adversarial intent. Race conditions, missing validation and
            reflected injections fall out of the diff in seconds.
          </p>
          <ol className="steps">
            <li>
              <span>01</span>
              <div>Warm a headless browser into the checkout step.</div>
            </li>
            <li>
              <span>02</span>
              <div>Snapshot cookies, localStorage and origins.</div>
            </li>
            <li>
              <span>03</span>
              <div>Fan out four headed windows with identical state.</div>
            </li>
            <li>
              <span>04</span>
              <div>Diff outcomes against the control fork.</div>
            </li>
          </ol>
        </section>

        <aside className="plan">
          <div className="section-label">02 · Target</div>
          <dl className="spec">
            <dt>app</dt>
            <dd>buggy-cart · localhost</dd>
            <dt>warmup</dt>
            <dd>add 2 items · open checkout</dd>
            <dt>forks</dt>
            <dd>4 · headed Chromium, 2×2 grid</dd>
            <dt>budget</dt>
            <dd>~30 seconds</dd>
          </dl>

          <div className="section-label" style={{ marginTop: '1.75rem' }}>
            03 · Strategies
          </div>
          <ul className="strategy-list">
            {STRATEGIES.map((s) => (
              <li key={s.name}>
                <span className="chip" style={{ background: s.color, color: s.color }} />
                <div>
                  <div className="mono">{s.name}</div>
                  <div className="muted">{s.blurb}</div>
                </div>
              </li>
            ))}
          </ul>
        </aside>
      </main>

      <footer className="landing-footer">
        <div className="cta-row">
          <button className="begin-btn" onClick={startRun} disabled={starting}>
            {starting ? (
              <>
                <span className="spinner" /> spawning forks…
              </>
            ) : (
              <>
                Begin probe <span className="arrow">→</span>
              </>
            )}
          </button>
          <span className="kbd-hint">
            press <kbd>↵</kbd> to start
          </span>
        </div>
        <div className="warn">
          4 Chromium windows will open on-screen during the run &mdash;
          arrange monitors accordingly.
        </div>
      </footer>
    </div>
  )
}
