'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ForkStatus, RunEvent } from '../lib/events'

const ExpandContext = createContext<((id: string) => void) | null>(null)

type AgentThought = {
  step: number
  type: 'click' | 'fill' | 'press' | 'eval' | 'spawn' | 'done'
  reason: string
  selector?: string
  value?: string
  key?: string
  code?: string
  verdict?: 'bug' | 'passed' | 'tolerable'
  spawnCount?: number
}

type ForkNode = {
  id: string
  strategyName: string
  description: string
  intent: number
  status: ForkStatus
  phaseId?: string
  phaseIndex?: number
  parentForkId?: string
  ordersCreated?: number
  durMs?: number
  verdict?: 'passed' | 'bug' | 'tolerable' | 'error'
  excess?: number
  error?: string
  bugDetail?: string
  frameB64?: string
  frameIsFinal?: boolean
  thoughts?: AgentThought[]
  /** Computed at render time: how many forks descend directly from this one. */
  childCount?: number
}

type RootNode = {
  cartSize?: number
  origins?: number
  targetUrl?: string
}

const STATUS_COLOR: Record<
  ForkStatus,
  { border: string; bg: string; accent: string; label: string; swatch: string }
> = {
  pending:    { border: '#2a2c32', bg: '#121317', accent: '#7a7f89', label: 'queued',     swatch: '#5a5f69' },
  navigating: { border: '#7aa7ff', bg: '#0f1726', accent: '#9cbcff', label: 'navigating', swatch: '#7aa7ff' },
  acting:     { border: '#fbbf24', bg: '#1e1707', accent: '#fde047', label: 'executing',  swatch: '#fbbf24' },
  passed:     { border: '#7ddc9c', bg: '#0d1a13', accent: '#7ddc9c', label: 'passed',     swatch: '#7ddc9c' },
  tolerable:  { border: '#64748b', bg: '#141b22', accent: '#9aa6b5', label: 'tolerable',  swatch: '#64748b' },
  bug:        { border: '#ff6b6b', bg: '#2a0f10', accent: '#ffb4b4', label: 'bug found',  swatch: '#ff6b6b' },
  error:      { border: '#c9a8ff', bg: '#1a1227', accent: '#e3cffe', label: 'errored',    swatch: '#c9a8ff' },
}

function RootNodeView({ data }: NodeProps<Node<RootNode>>) {
  return (
    <div
      style={{
        background: '#121317',
        border: '1px solid #2f333b',
        borderRadius: 10,
        padding: '0.9rem 1.1rem',
        color: '#ececee',
        minWidth: 260,
        fontFamily: 'var(--font-sans), system-ui',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono), monospace',
          fontSize: 10,
          color: '#5a5f69',
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
        }}
      >
        Fork point · shared state
      </div>
      <div style={{ fontSize: 15, marginTop: 6, fontWeight: 500, letterSpacing: '-0.01em' }}>
        Cart has {data.cartSize ?? '—'} items
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono), monospace',
          fontSize: 11,
          color: '#9ea3ad',
          marginTop: 6,
          display: 'flex',
          gap: 12,
        }}
      >
        <span>storageState</span>
        <span>·</span>
        <span>
          {data.origins ?? 0} origin{data.origins === 1 ? '' : 's'}
        </span>
      </div>
      {data.targetUrl && (
        <div
          style={{
            fontFamily: 'var(--font-mono), monospace',
            fontSize: 10,
            color: '#5a5f69',
            marginTop: 4,
          }}
        >
          {data.targetUrl}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  )
}

function ForkNodeView({ id, data, selected }: NodeProps<Node<ForkNode>>) {
  const c = STATUS_COLOR[data.status]
  const isPulsing = data.status === 'navigating' || data.status === 'acting'
  const isTrunk = (data.childCount ?? 0) > 0
  const trunkAccent = '#a78bfa'
  const onExpand = useContext(ExpandContext)
  return (
    <div
      style={{
        background: c.bg,
        border: `${isTrunk ? '2px' : '1px'} solid ${isTrunk ? trunkAccent : c.border}`,
        borderRadius: 10,
        padding: '0.75rem 0.85rem 0.85rem',
        color: '#ececee',
        width: 340,
        fontFamily: 'var(--font-sans), system-ui',
        boxShadow: selected
          ? `0 0 0 2px ${trunkAccent}66, 0 10px 30px rgba(0,0,0,0.45)`
          : isTrunk
          ? `0 0 28px ${trunkAccent}40, 0 10px 30px rgba(0,0,0,0.5)`
          : isPulsing
          ? `0 0 24px ${c.border}55`
          : '0 6px 18px rgba(0,0,0,0.35)',
        transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
        position: 'relative',
      }}
    >
      {isTrunk && (
        <div
          style={{
            position: 'absolute',
            top: -10,
            left: '50%',
            transform: 'translateX(-50%)',
            background: trunkAccent,
            color: '#0a0b0d',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.1em',
            padding: '2px 8px',
            borderRadius: 3,
            textTransform: 'uppercase',
            boxShadow: `0 4px 12px ${trunkAccent}55`,
            whiteSpace: 'nowrap',
          }}
        >
          ↳ FORK POINT · spawned {data.childCount}
        </div>
      )}
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-mono), monospace',
          fontSize: 10,
          color: c.accent,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          fontWeight: 500,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 2,
            background: c.swatch,
            boxShadow: isPulsing ? `0 0 6px ${c.swatch}` : 'none',
          }}
        />
        {c.label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono), monospace',
          fontSize: 12.5,
          marginTop: 5,
          fontWeight: 500,
          letterSpacing: '-0.005em',
        }}
      >
        {data.strategyName}
      </div>
      <div style={{ fontSize: 11, color: '#9ea3ad', marginTop: 3, lineHeight: 1.4 }}>
        {data.description}
      </div>

      {/* Embedded live viewport — JPEG frames streamed from CDP. Click to expand. */}
      <div
        onClick={(e) => {
          e.stopPropagation()
          onExpand?.(id)
        }}
        title="click to expand"
        style={{
          marginTop: 8,
          position: 'relative',
          aspectRatio: '16 / 10',
          background: '#0a0b0d',
          border: '1px solid #1d1f25',
          borderRadius: 6,
          overflow: 'hidden',
          cursor: 'zoom-in',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 6,
            left: 6,
            zIndex: 2,
            fontFamily: 'var(--font-mono), monospace',
            fontSize: 9,
            color: '#cbd0d9',
            background: 'rgba(10,11,13,0.7)',
            border: '1px solid #1d1f25',
            padding: '2px 6px',
            borderRadius: 3,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            pointerEvents: 'none',
          }}
        >
          ⤢ expand
        </div>
        {data.frameB64 ? (
          <img
            src={`data:image/jpeg;base64,${data.frameB64}`}
            alt=""
            draggable={false}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'top center',
              display: 'block',
              opacity: data.frameIsFinal && (data.status === 'bug' || data.status === 'error') ? 1 : 0.95,
            }}
          />
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              color: '#5a5f69',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            {data.status === 'pending' ? 'queued' : 'connecting…'}
          </div>
        )}
        {isPulsing && (
          <div
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: '#ff6b6b',
              boxShadow: '0 0 6px #ff6b6b',
              animation: 'pulse 1.3s ease-in-out infinite',
            }}
          />
        )}
        {data.frameIsFinal && (data.status === 'bug' || data.status === 'error') && (
          <div
            style={{
              position: 'absolute',
              bottom: 6,
              left: 6,
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 9,
              color: '#fff',
              background: 'rgba(220,38,38,0.85)',
              padding: '2px 6px',
              borderRadius: 3,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            frozen
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: '1px dashed #2a2c32',
          fontFamily: 'var(--font-mono), monospace',
          fontSize: 11,
          color: '#9ea3ad',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 4,
        }}
      >
        <span>
          orders:{' '}
          <strong style={{ color: data.verdict === 'bug' ? '#ffb4b4' : '#ececee', fontWeight: 500 }}>
            {data.ordersCreated ?? '—'}
          </strong>
        </span>
        {typeof data.durMs === 'number' && (
          <span>
            time: <strong style={{ color: '#ececee', fontWeight: 500 }}>{data.durMs}ms</strong>
          </span>
        )}
        {data.excess !== undefined && (
          <span style={{ color: '#ffb4b4', gridColumn: '1 / -1' }}>
            +{data.excess} duplicate{data.excess > 1 ? 's' : ''}
          </span>
        )}
      </div>
      {data.thoughts && data.thoughts.length > 0 && (() => {
        const latest = data.thoughts[data.thoughts.length - 1]
        const verb =
          latest.type === 'click' ? `click ${latest.selector ?? ''}`
          : latest.type === 'fill' ? `fill ${latest.selector ?? ''}`
          : latest.type === 'press' ? `press ${latest.key ?? ''}`
          : latest.type === 'eval' ? 'eval'
          : latest.type === 'spawn' ? `spawn ×${latest.spawnCount ?? '?'}`
          : latest.type === 'done' ? `done · ${latest.verdict ?? ''}`
          : latest.type
        return (
          <div
            style={{
              marginTop: 8,
              padding: '6px 8px',
              border: '1px solid #1d1f25',
              borderRadius: 4,
              background: '#0a0b0d',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              color: '#9ea3ad',
              lineHeight: 1.45,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#5a5f69', marginBottom: 2 }}>
              <span>step {latest.step + 1}</span>
              <span style={{ color: '#7aa7ff' }}>▸ {verb}</span>
            </div>
            <div style={{ color: '#cbd0d9' }}>{latest.reason}</div>
          </div>
        )
      })()}
      {data.bugDetail && (
        <div
          style={{
            marginTop: 8,
            fontSize: 10.5,
            fontFamily: 'var(--font-mono), monospace',
            color: data.verdict === 'bug' ? '#ffb4b4' : '#9ea3ad',
            wordBreak: 'break-word',
            lineHeight: 1.4,
          }}
        >
          {data.bugDetail}
        </div>
      )}
      {data.error && (
        <div
          style={{
            marginTop: 8,
            fontSize: 10,
            fontFamily: 'var(--font-mono), monospace',
            color: '#e3cffe',
            wordBreak: 'break-word',
          }}
        >
          err: {data.error.slice(0, 80)}
        </div>
      )}
    </div>
  )
}

const nodeTypes = { root: RootNodeView, fork: ForkNodeView }

function isRunning(s: ForkStatus) {
  return s === 'pending' || s === 'navigating' || s === 'acting'
}

function TreeInner({
  root,
  forks,
  selectedId,
  onSelect,
  onExpand,
}: {
  root: RootNode
  forks: ForkNode[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onExpand: (id: string) => void
}) {
  const { fitView } = useReactFlow()
  const prevForkCount = useRef(0)

  const { nodes, edges } = useMemo(() => {
    const SLOT_W = 380 // horizontal slot per leaf node (incl. gap)
    const LEVEL_Y = 560
    const ROOT_HALF = 130 // root visual half-width
    const FORK_HALF = 170 // fork visual half-width (node is 340 wide)
    const TRUNK_COLOR = '#a78bfa'

    // Build parent → children adjacency.
    const childrenOf = new Map<string, ForkNode[]>()
    for (const f of forks) {
      const parent = f.parentForkId ?? 'root'
      if (!childrenOf.has(parent)) childrenOf.set(parent, [])
      childrenOf.get(parent)!.push(f)
    }

    // Bottom-up: each leaf takes 1 slot; each parent takes the sum of its
    // children's slots. This is the key fix — siblings that each have their
    // own subtree get proportional horizontal space, so the subtrees never
    // overlap regardless of how deep / wide each branch grows.
    const subtreeSlots = new Map<string, number>()
    function computeSlots(id: string): number {
      if (subtreeSlots.has(id)) return subtreeSlots.get(id)!
      const kids = childrenOf.get(id) ?? []
      const slots =
        kids.length === 0
          ? 1
          : kids.reduce((sum, k) => sum + computeSlots(k.id), 0)
      subtreeSlots.set(id, slots)
      return slots
    }

    // Sort: place the trunk-with-the-widest-subtree in the middle of its row
    // so the deepest path stays roughly under its parent. Other children
    // distribute around it proportionally.
    function sortForLayout(kids: ForkNode[]): ForkNode[] {
      if (kids.length < 2) return kids
      const widest = [...kids].sort(
        (a, b) => (subtreeSlots.get(b.id) ?? 1) - (subtreeSlots.get(a.id) ?? 1)
      )[0]
      const widestSlots = subtreeSlots.get(widest.id) ?? 1
      // Only relocate-to-middle if there's a clearly widest subtree
      if (widestSlots <= 1) return kids
      const others = kids.filter((k) => k.id !== widest.id)
      const middle = Math.floor(kids.length / 2)
      return [...others.slice(0, middle), widest, ...others.slice(middle)]
    }

    const pos = new Map<string, { x: number; y: number }>()

    // Place a node at a given visual center, then recursively allocate
    // each child a slice of space proportional to its subtree's slot count.
    function place(id: string, centerX: number, depth: number) {
      const halfW = id === 'root' ? ROOT_HALF : FORK_HALF
      pos.set(id, { x: centerX - halfW, y: depth * LEVEL_Y })

      const kidsRaw = childrenOf.get(id) ?? []
      if (kidsRaw.length === 0) return
      const kids = sortForLayout(kidsRaw)

      const totalSlots = kids.reduce((s, k) => s + (subtreeSlots.get(k.id) ?? 1), 0)
      const totalWidth = totalSlots * SLOT_W
      let cursor = centerX - totalWidth / 2
      for (const k of kids) {
        const kSlots = subtreeSlots.get(k.id) ?? 1
        const kWidth = kSlots * SLOT_W
        const kCenter = cursor + kWidth / 2
        place(k.id, kCenter, depth + 1)
        cursor += kWidth
      }
    }

    computeSlots('root')
    place('root', 0, 0)

    const rootNode: Node = {
      id: 'root',
      type: 'root',
      position: pos.get('root')!,
      data: root as any,
      draggable: false,
      selectable: false,
    }

    // Tag each fork with its child count so the node renderer can show the
    // "↳ FORK POINT" trunk badge.
    const forkNodes: Node[] = forks
      .filter((f) => pos.has(f.id))
      .map((f) => ({
        id: f.id,
        type: 'fork',
        position: pos.get(f.id)!,
        data: { ...f, childCount: childrenOf.get(f.id)?.length ?? 0 } as any,
        draggable: false,
        selected: f.id === selectedId,
      }))

    const forkEdges: Edge[] = forks
      .filter((f) => pos.has(f.id))
      .map((f) => {
        const parentId = f.parentForkId ?? 'root'
        // If parent is itself a fork that has children (i.e., it's the trunk),
        // brand this edge purple + thicker so the eye follows the trunk path.
        const sourceIsTrunk =
          parentId !== 'root' && (childrenOf.get(parentId)?.length ?? 0) > 0

        const baseStroke =
          f.status === 'bug' ? '#ff6b6b'
          : f.status === 'passed' ? '#7ddc9c'
          : f.status === 'tolerable' ? '#64748b'
          : f.status === 'error' ? '#c9a8ff'
          : f.status === 'navigating' || f.status === 'acting' ? '#7aa7ff'
          : '#2f333b'

        const stroke = sourceIsTrunk ? TRUNK_COLOR : baseStroke
        const strokeWidth = sourceIsTrunk ? 2.5 : 1.5

        return {
          id: `e-${parentId}-${f.id}`,
          source: parentId,
          target: f.id,
          type: 'smoothstep',
          animated: isRunning(f.status) || sourceIsTrunk,
          style: { stroke, strokeWidth },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        }
      })

    return { nodes: [rootNode, ...forkNodes], edges: forkEdges }
  }, [forks, root, selectedId])

  useEffect(() => {
    if (forks.length !== prevForkCount.current) {
      prevForkCount.current = forks.length
      const t = setTimeout(() => {
        fitView({ padding: 0.28, duration: 400 })
      }, 40)
      return () => clearTimeout(t)
    }
  }, [forks.length, fitView])

  return (
    <ExpandContext.Provider value={onExpand}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.28 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnDrag
        zoomOnScroll
        minZoom={0.4}
        maxZoom={1.6}
        onNodeClick={(_, node) => {
          if (node.id === 'root') onSelect(null)
          else onSelect(node.id)
        }}
        onPaneClick={() => onSelect(null)}
      >
        <Background color="#1a1c21" gap={28} size={1} />
        <Controls
          showInteractive={false}
          position="bottom-right"
          style={{ background: '#111215', border: '1px solid #23262d' }}
        />
      </ReactFlow>
    </ExpandContext.Provider>
  )
}

export function RunView({ runId }: { runId: string }) {
  const [root, setRoot] = useState<RootNode>({})
  const [forks, setForks] = useState<ForkNode[]>([])
  const [complete, setComplete] = useState(false)
  const [summary, setSummary] = useState<{ bugsFound: number; totalForks: number } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const handleExpand = useCallback((id: string) => setExpandedId(id), [])
  const closeExpanded = useCallback(() => setExpandedId(null), [])

  useEffect(() => {
    if (!expandedId) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setExpandedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expandedId])

  const expanded = expandedId ? forks.find((f) => f.id === expandedId) ?? null : null

  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/stream`)
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as RunEvent
        switch (evt.type) {
          case 'run_started':
            setRoot((r) => ({ ...r, targetUrl: evt.targetUrl }))
            break
          case 'initial_state_reached':
            setRoot((r) => ({ ...r, cartSize: evt.cartSize }))
            break
          case 'storage_snapshotted':
            setRoot((r) => ({ ...r, origins: evt.origins }))
            break
          case 'fork_created':
            setForks((fs) =>
              fs.some((f) => f.id === evt.forkId)
                ? fs
                : [
                    ...fs,
                    {
                      id: evt.forkId,
                      strategyName: evt.strategyName,
                      description: evt.description,
                      intent: evt.intent,
                      status: 'pending',
                      phaseId: evt.phaseId,
                      phaseIndex: evt.phaseIndex,
                      parentForkId: evt.parentForkId,
                    },
                  ]
            )
            break
          case 'fork_status':
            setForks((fs) =>
              fs.map((f) => (f.id === evt.forkId ? { ...f, status: evt.status } : f))
            )
            break
          case 'fork_frame':
            setForks((fs) =>
              fs.map((f) =>
                f.id === evt.forkId
                  ? { ...f, frameB64: evt.data, frameIsFinal: !!evt.final }
                  : f
              )
            )
            break
          case 'agent_thought':
            setForks((fs) =>
              fs.map((f) => {
                if (f.id !== evt.forkId) return f
                const a = evt.action
                const t: AgentThought = {
                  step: evt.step,
                  type: a.type,
                  reason: a.reason,
                  selector: 'selector' in a ? a.selector : undefined,
                  value: 'value' in a ? a.value : undefined,
                  key: 'key' in a ? a.key : undefined,
                  code: 'code' in a ? a.code : undefined,
                  verdict: 'verdict' in a ? a.verdict : undefined,
                  spawnCount: a.type === 'spawn' ? a.intents.length : undefined,
                }
                return { ...f, thoughts: [...(f.thoughts ?? []), t] }
              })
            )
            break
          case 'fork_complete':
            setForks((fs) =>
              fs.map((f) =>
                f.id === evt.forkId
                  ? {
                      ...f,
                      ordersCreated: evt.ordersCreated,
                      durMs: evt.durMs,
                      verdict: evt.verdict,
                      excess: evt.excess,
                      error: evt.error,
                      bugDetail: evt.bugDetail,
                      status:
                        evt.verdict === 'bug'
                          ? 'bug'
                          : evt.verdict === 'error'
                          ? 'error'
                          : evt.verdict === 'tolerable'
                          ? 'tolerable'
                          : 'passed',
                    }
                  : f
              )
            )
            break
          case 'run_complete':
            setComplete(true)
            setSummary({ bugsFound: evt.bugsFound, totalForks: evt.totalForks })
            es.close()
            break
        }
      } catch {}
    }
    es.onerror = () => {
      // SSE closes on run completion
    }
    return () => es.close()
  }, [runId])

  const totalForks = forks.length
  const completedForks = forks.filter((f) => !isRunning(f.status)).length
  const bugsSoFar = forks.filter((f) => f.status === 'bug').length
  const errorsSoFar = forks.filter((f) => f.status === 'error').length
  const progressPct = totalForks === 0 ? 0 : (completedForks / totalForks) * 100

  const overallState: 'warming' | 'running' | 'done' =
    complete ? 'done' : totalForks === 0 ? 'warming' : 'running'

  return (
    <div className="run-shell">
      <header className="run-top">
        <div className="brand">
          ◆ <strong>Parallel Agents</strong>
          <span className="tag">/ run {shortId(runId)}</span>
        </div>

        <div className="run-progress">
          <span className="counter">
            {overallState === 'warming' && 'warming up shared state…'}
            {overallState === 'running' && (
              <>
                <strong>{completedForks}</strong> / {totalForks} forks complete
                {bugsSoFar > 0 && (
                  <>
                    {' · '}
                    <strong style={{ color: '#ff6b6b' }}>
                      {bugsSoFar} bug{bugsSoFar > 1 ? 's' : ''}
                    </strong>
                  </>
                )}
              </>
            )}
            {overallState === 'done' && summary && (
              <>
                run complete ·{' '}
                <strong style={{ color: summary.bugsFound > 0 ? '#ff6b6b' : '#7ddc9c' }}>
                  {summary.bugsFound > 0
                    ? `${summary.bugsFound} bug${summary.bugsFound > 1 ? 's' : ''}`
                    : 'no bugs'}
                </strong>{' '}
                across {summary.totalForks} forks
              </>
            )}
          </span>
          <div className={`progress-bar ${bugsSoFar > 0 ? 'has-bugs' : ''}`}>
            <div className="fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>

        <div className="badges">
          {overallState === 'warming' && (
            <span className="status-pill running">
              <span className="dot" /> warming
            </span>
          )}
          {overallState === 'running' && (
            <span className="status-pill running">
              <span className="dot" /> running
            </span>
          )}
          {overallState === 'done' && bugsSoFar === 0 && errorsSoFar === 0 && (
            <span className="status-pill done">
              <span className="dot" /> clean
            </span>
          )}
          {overallState === 'done' && (bugsSoFar > 0 || errorsSoFar > 0) && (
            <span className="status-pill bugs">
              <span className="dot" /> bugs
            </span>
          )}
        </div>
      </header>

      <div className="run-body">
        <aside className="run-sidebar">
          <div className="sidebar-section">
            <div className="section-label">Shared state</div>
          </div>
          <dl className="sidebar-state">
            <dt>target</dt>
            <dd>{root.targetUrl ?? '—'}</dd>
            <dt>cart</dt>
            <dd>{root.cartSize !== undefined ? `${root.cartSize} items` : '—'}</dd>
            <dt>origins</dt>
            <dd>{root.origins ?? '—'}</dd>
          </dl>

          <div className="sidebar-section">
            <div className="section-label">
              Forks{' '}
              {totalForks > 0 && (
                <span style={{ color: 'var(--ink-faint)' }}>({totalForks})</span>
              )}
            </div>
          </div>
          <div className="fork-list">
            {forks.length === 0 && (
              <div
                style={{
                  padding: '0.6rem 0.8rem',
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: 12,
                  color: 'var(--ink-faint)',
                }}
              >
                awaiting snapshot…
              </div>
            )}
            {forks.map((f) => {
              const c = STATUS_COLOR[f.status]
              const cls =
                f.status === 'bug' ? 'bug'
                : f.status === 'passed' ? 'passed'
                : f.status === 'error' ? 'error'
                : isRunning(f.status) ? 'running'
                : ''
              return (
                <button
                  key={f.id}
                  className={`fork-card ${cls} ${selectedId === f.id ? 'is-selected' : ''}`}
                  onClick={() => setSelectedId(selectedId === f.id ? null : f.id)}
                >
                  <div className="fork-card-head">
                    <span className="fork-dot" style={{ background: c.swatch }} />
                    <span className="name">{f.strategyName}</span>
                    <span className="stat" style={{ color: c.accent }}>
                      {c.label}
                    </span>
                  </div>
                  <div className="desc">{f.description}</div>
                  {(f.verdict || typeof f.durMs === 'number') && (
                    <div className="footline">
                      <span>
                        {f.ordersCreated !== undefined && (
                          <>
                            {f.ordersCreated} order{f.ordersCreated === 1 ? '' : 's'}
                          </>
                        )}
                        {f.excess !== undefined && <> · +{f.excess} extra</>}
                      </span>
                      <span>
                        {typeof f.durMs === 'number' ? `${(f.durMs / 1000).toFixed(1)}s` : ''}
                      </span>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </aside>

        <section className="tree-area">
          {complete && summary && (
            <div className={`summary-banner ${summary.bugsFound > 0 ? 'bugs' : 'clean'}`}>
              <span className="label">
                {summary.bugsFound > 0 ? 'bugs found' : 'clean run'}
              </span>
              <strong>
                {summary.bugsFound > 0
                  ? `${summary.bugsFound} / ${summary.totalForks}`
                  : `0 / ${summary.totalForks}`}
              </strong>
            </div>
          )}
          <ReactFlowProvider>
            <TreeInner
              root={root}
              forks={forks}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onExpand={handleExpand}
            />
          </ReactFlowProvider>
        </section>
      </div>
      {expanded && <ExpandedFork fork={expanded} onClose={closeExpanded} />}
    </div>
  )
}

function ExpandedFork({ fork, onClose }: { fork: ForkNode; onClose: () => void }) {
  const c = STATUS_COLOR[fork.status]
  const isPulsing = fork.status === 'navigating' || fork.status === 'acting'
  const thoughts = fork.thoughts ?? []

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(6,7,9,0.82)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'grid',
        placeItems: 'center',
        padding: '3.5vh 3vw',
        animation: 'fadeIn 0.15s ease-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#0d0e11',
          border: '1px solid #23262d',
          borderRadius: 12,
          width: 'min(1280px, 96vw)',
          maxHeight: '94vh',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 360px',
          overflow: 'hidden',
          boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
          fontFamily: 'var(--font-sans), system-ui',
          color: '#ececee',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, background: '#06070a' }}>
          <div
            style={{
              padding: '0.85rem 1rem',
              borderBottom: '1px solid #1d1f25',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: c.swatch,
                boxShadow: isPulsing ? `0 0 8px ${c.swatch}` : 'none',
              }}
            />
            <span
              style={{
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 11,
                color: c.accent,
                textTransform: 'uppercase',
                letterSpacing: '0.14em',
              }}
            >
              {c.label}
            </span>
            <span style={{ color: '#5a5f69' }}>·</span>
            <strong
              style={{
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: '-0.005em',
              }}
            >
              {fork.strategyName}
            </strong>
            <span style={{ flex: 1 }} />
            <button
              onClick={onClose}
              aria-label="close"
              style={{
                border: '1px solid #2f333b',
                background: '#111215',
                color: '#cbd0d9',
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 11,
                padding: '4px 10px',
                borderRadius: 4,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
              }}
            >
              close · esc
            </button>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              position: 'relative',
              background: '#000',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            {fork.frameB64 ? (
              <img
                src={`data:image/jpeg;base64,${fork.frameB64}`}
                alt={fork.strategyName}
                draggable={false}
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  display: 'block',
                }}
              />
            ) : (
              <div
                style={{
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: 12,
                  color: '#5a5f69',
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                }}
              >
                {fork.status === 'pending' ? 'queued' : 'connecting…'}
              </div>
            )}
            {isPulsing && (
              <div
                style={{
                  position: 'absolute',
                  top: 12,
                  right: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 8px',
                  background: 'rgba(10,11,13,0.7)',
                  border: '1px solid #1d1f25',
                  borderRadius: 4,
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: 10,
                  color: '#ffb4b4',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: '#ff6b6b',
                    boxShadow: '0 0 6px #ff6b6b',
                    animation: 'pulse 1.3s ease-in-out infinite',
                  }}
                />
                live
              </div>
            )}
          </div>
        </div>
        <aside
          style={{
            borderLeft: '1px solid #1d1f25',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: '#0d0e11',
          }}
        >
          <div style={{ padding: '0.85rem 1rem', borderBottom: '1px solid #1d1f25' }}>
            <div
              style={{
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 10,
                color: '#5a5f69',
                textTransform: 'uppercase',
                letterSpacing: '0.14em',
              }}
            >
              Strategy
            </div>
            <div style={{ fontSize: 13, color: '#cbd0d9', marginTop: 4, lineHeight: 1.5 }}>
              {fork.description}
            </div>
            <div
              style={{
                marginTop: 10,
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 11,
                color: '#9ea3ad',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 6,
              }}
            >
              <span>
                orders:{' '}
                <strong style={{ color: fork.verdict === 'bug' ? '#ffb4b4' : '#ececee', fontWeight: 500 }}>
                  {fork.ordersCreated ?? '—'}
                </strong>
              </span>
              {typeof fork.durMs === 'number' && (
                <span>
                  time: <strong style={{ color: '#ececee', fontWeight: 500 }}>{fork.durMs}ms</strong>
                </span>
              )}
              {fork.excess !== undefined && (
                <span style={{ color: '#ffb4b4', gridColumn: '1 / -1' }}>
                  +{fork.excess} duplicate{fork.excess > 1 ? 's' : ''}
                </span>
              )}
            </div>
            {fork.bugDetail && (
              <div
                style={{
                  marginTop: 10,
                  padding: '8px 10px',
                  border: '1px solid #2a0f10',
                  background: '#190a0b',
                  borderRadius: 4,
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: 11,
                  color: '#ffb4b4',
                  lineHeight: 1.45,
                  wordBreak: 'break-word',
                }}
              >
                {fork.bugDetail}
              </div>
            )}
            {fork.error && (
              <div
                style={{
                  marginTop: 10,
                  padding: '8px 10px',
                  border: '1px solid #1a1227',
                  background: '#120c1c',
                  borderRadius: 4,
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: 11,
                  color: '#e3cffe',
                  lineHeight: 1.45,
                  wordBreak: 'break-word',
                }}
              >
                err: {fork.error}
              </div>
            )}
          </div>
          <div
            style={{
              padding: '0.7rem 1rem 0.4rem',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              color: '#5a5f69',
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span>Agent log</span>
            <span>{thoughts.length} step{thoughts.length === 1 ? '' : 's'}</span>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              padding: '0 1rem 1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {thoughts.length === 0 && (
              <div
                style={{
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: 11,
                  color: '#5a5f69',
                }}
              >
                no actions yet…
              </div>
            )}
            {thoughts.map((t, i) => {
              const verb =
                t.type === 'click' ? `click ${t.selector ?? ''}`
                : t.type === 'fill' ? `fill ${t.selector ?? ''} ${t.value ? `= ${JSON.stringify(t.value)}` : ''}`
                : t.type === 'press' ? `press ${t.key ?? ''}`
                : t.type === 'eval' ? 'eval'
                : t.type === 'spawn' ? `spawn ×${t.spawnCount ?? '?'}`
                : t.type === 'done' ? `done · ${t.verdict ?? ''}`
                : t.type
              return (
                <div
                  key={i}
                  style={{
                    padding: '6px 8px',
                    border: '1px solid #1d1f25',
                    borderRadius: 4,
                    background: '#0a0b0d',
                    fontFamily: 'var(--font-mono), monospace',
                    fontSize: 10.5,
                    lineHeight: 1.45,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      color: '#5a5f69',
                      marginBottom: 2,
                    }}
                  >
                    <span>step {t.step + 1}</span>
                    <span style={{ color: '#7aa7ff' }}>▸ {verb}</span>
                  </div>
                  <div style={{ color: '#cbd0d9' }}>{t.reason}</div>
                  {t.code && (
                    <pre
                      style={{
                        margin: '4px 0 0',
                        padding: '4px 6px',
                        background: '#06070a',
                        border: '1px solid #1d1f25',
                        borderRadius: 3,
                        color: '#9ea3ad',
                        fontSize: 10,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {t.code}
                    </pre>
                  )}
                </div>
              )
            })}
          </div>
        </aside>
      </div>
    </div>
  )
}

function shortId(id: string): string {
  if (id.length <= 10) return id
  return `${id.slice(0, 4)}…${id.slice(-4)}`
}

export const ForkTreeViewer = RunView
