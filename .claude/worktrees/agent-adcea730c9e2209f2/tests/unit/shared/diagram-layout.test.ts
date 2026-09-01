import { describe, test, expect } from 'bun:test'
import { applyLayout, reapplyLayout } from '../../../src/shared/diagram-layout'
import type { DiagramDoc } from '../../../src/shared/diagram-types'

const DOC_NO_POSITIONS: DiagramDoc = {
  nodes: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'c' },
  ],
}

const DOC_WITH_POSITIONS: DiagramDoc = {
  nodes: [
    { id: 'x', label: 'X', position: { x: 10, y: 20 } },
    { id: 'y', label: 'Y', position: { x: 200, y: 20 } },
  ],
  edges: [{ id: 'e1', source: 'x', target: 'y' }],
}

describe('applyLayout', () => {
  test('assigns positions to nodes that lack them', () => {
    const laid = applyLayout(DOC_NO_POSITIONS)
    for (const node of laid.nodes) {
      expect(node.position).toBeDefined()
      expect(typeof node.position!.x).toBe('number')
      expect(typeof node.position!.y).toBe('number')
    }
  })

  test('returns the same doc reference when all nodes already have positions', () => {
    const laid = applyLayout(DOC_WITH_POSITIONS)
    // No layout run needed — existing positions must be preserved exactly
    expect(laid).toBe(DOC_WITH_POSITIONS)
  })

  test('reserves extra horizontal room when an edge has a label', () => {
    // A labeled edge must push its ranks further apart than an unlabeled one,
    // so the mid-edge label text doesn't overlap the connected nodes.
    const span = (edgeLabel?: string) => {
      const laid = applyLayout({
        nodes: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b', label: edgeLabel }],
      })
      const a = laid.nodes.find((n) => n.id === 'a')!.position!
      const b = laid.nodes.find((n) => n.id === 'b')!.position!
      return b.x - a.x
    }
    expect(span('handles a long descriptive label')).toBeGreaterThan(span())
  })

  test('lays a chain out horizontally for LR and vertically for TB', () => {
    // The direction argument must change which axis ranks advance along: LR
    // spreads the chain across x, TB stacks it down y. This is what makes the
    // toolbar's layout options actually do something different.
    const spans = (direction: 'LR' | 'TB') => {
      const laid = applyLayout(DOC_NO_POSITIONS, direction)
      const xs = laid.nodes.map((n) => n.position!.x)
      const ys = laid.nodes.map((n) => n.position!.y)
      return {
        x: Math.max(...xs) - Math.min(...xs),
        y: Math.max(...ys) - Math.min(...ys),
      }
    }
    const lr = spans('LR')
    const tb = spans('TB')
    // LR flows along x; TB flows along y.
    expect(lr.x).toBeGreaterThan(lr.y)
    expect(tb.y).toBeGreaterThan(tb.x)
  })

  test('RL mirrors LR — same horizontal spread, opposite flow', () => {
    const xSpan = (direction: 'LR' | 'RL') => {
      const laid = applyLayout(DOC_NO_POSITIONS, direction)
      const xs = laid.nodes.map((n) => n.position!.x)
      return Math.max(...xs) - Math.min(...xs)
    }
    // Both are horizontal layouts, so the graph occupies the same width.
    expect(xSpan('RL')).toBeCloseTo(xSpan('LR'), 0)
  })

  test('defaults to LR when no direction is given', () => {
    const explicit = applyLayout(DOC_NO_POSITIONS, 'LR')
    const implicit = applyLayout(DOC_NO_POSITIONS)
    expect(implicit.nodes.map((n) => n.position)).toEqual(explicit.nodes.map((n) => n.position))
  })

  test('does not overwrite existing positions in a mixed doc', () => {
    const mixed: DiagramDoc = {
      nodes: [
        { id: 'existing', label: 'Existing', position: { x: 999, y: 888 } },
        { id: 'new', label: 'New' },
      ],
      edges: [{ id: 'e1', source: 'existing', target: 'new' }],
    }
    const laid = applyLayout(mixed)
    const existingNode = laid.nodes.find((n) => n.id === 'existing')!
    // The pre-existing position must be preserved — layout is only applied where absent
    expect(existingNode.position).toEqual({ x: 999, y: 888 })

    const newNode = laid.nodes.find((n) => n.id === 'new')!
    expect(newNode.position).toBeDefined()
  })

  test('rich node (subtitle + badges) is allotted more vertical space than a bare node', () => {
    // Guards the content-aware sizing fix: a node with subtitle + badges is taller,
    // so dagre must reserve more room between TB ranks than for a bare node.
    const verticalSpan = (rich: boolean) => {
      const laid = applyLayout(
        {
          nodes: [
            {
              id: 'a',
              label: 'Service',
              ...(rich ? { subtitle: 'v1.2 · 3 instances', badges: ['autoscaling', 'v2'] } : {}),
            },
            { id: 'b', label: 'Database' },
          ],
          edges: [{ id: 'e1', source: 'a', target: 'b' }],
        },
        'TB',
      )
      const ya = laid.nodes.find((n) => n.id === 'a')!.position!.y
      const yb = laid.nodes.find((n) => n.id === 'b')!.position!.y
      return Math.abs(yb - ya)
    }
    // The rich node's taller estimated height must push rank-1 further down
    expect(verticalSpan(true)).toBeGreaterThan(verticalSpan(false))
  })

  test('entry node lands at minimum x in LR layout with a response-edge cycle', () => {
    // user → ingress → service + service → user (return edge creates a cycle).
    // acyclicer:'greedy' removes the feedback edge and source-first insertion
    // ensures user (lowest in-degree in the forward DAG) is rank-0 (leftmost).
    // Without these fixes, DFS insertion order would determine rank-0 arbitrarily.
    const laid = applyLayout(
      {
        nodes: [
          { id: 'user', label: 'User' },
          { id: 'ingress', label: 'Ingress' },
          { id: 'service', label: 'Service' },
        ],
        edges: [
          { id: 'e1', source: 'user', target: 'ingress' },
          { id: 'e2', source: 'ingress', target: 'service' },
          { id: 'e3', source: 'service', target: 'user', label: 'response' },
        ],
      },
      'LR',
    )
    const xs = Object.fromEntries(laid.nodes.map((n) => [n.id, n.position!.x]))
    expect(xs['user']).toBe(Math.min(...Object.values(xs)))
  })

})

describe('reapplyLayout', () => {
  test('replaces overlapping generated geometry instead of preserving it', () => {
    // Agent-created diagrams must open in the same clean state as an explicit
    // Auto-layout action, even if generated content supplied default positions.
    const laid = reapplyLayout({
      nodes: [
        { id: 'a', label: 'A', position: { x: 0, y: 0 }, width: 10, height: 10 },
        { id: 'b', label: 'B', position: { x: 0, y: 0 }, width: 10, height: 10 },
        { id: 'c', label: 'C', position: { x: 0, y: 0 }, width: 10, height: 10 },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
    })

    expect(new Set(laid.nodes.map((node) => `${node.position!.x},${node.position!.y}`)).size).toBe(3)
    expect(laid.nodes.every((node) => node.width === undefined && node.height === undefined)).toBe(true)
  })
})
