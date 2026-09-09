import { describe, expect, test } from 'bun:test'
import { routeEdges, overlaps, type RouteNode } from '@solus/workspace-ui/components/diagram/lib/edge-routing'
import { arrangeNodes, arrangementSelection } from '@solus/workspace-ui/components/diagram/lib/selection-arrangement'
import { includeRenderedBounds } from '@solus/workspace-ui/components/diagram/lib/export-bounds'
import { searchDiagram, nextSearchIndex } from '@solus/workspace-ui/components/diagram/lib/diagram-search'
import { applyLayout } from '@solus/contracts/diagram-layout'
import { parseDiagram, serializeDiagram } from '@solus/contracts/diagram-types'
import { flowEdgeToDiagram } from '@solus/workspace-ui/components/diagram/diagram-flow-map'
import { toFlowEdges } from '@solus/workspace-ui/components/diagram/lib/flow-builders'
import type { Node } from '@xyflow/svelte'

const nodes: RouteNode[] = [{ id: 'a', x: 0, y: 0, width: 192, height: 80 }, { id: 'b', x: 600, y: 0, width: 192, height: 80 }]
const edge = { id: 'first', source: 'a', target: 'b', label: 'Request', labelSize: { width: 180, height: 24 } }
const labelBox = (point: { x: number; y: number }) => ({ x: point.x - 90, y: point.y - 12, width: 180, height: 24 })
describe('diagram routing', () => {
  test('parallel and reverse connections have separate paths and readable labels', () => {
    const edges = [edge, { ...edge, id: 'second' }, { ...edge, id: 'reverse', source: 'b', target: 'a' }]
    const routes = [...routeEdges(nodes, edges).values()]
    expect(new Set(routes.map(r => r.path)).size).toBe(3)
    for (let i = 0; i < routes.length; i++) {
      const box = labelBox(routes[i].label)
      expect(nodes.some(n => overlaps(box, n))).toBe(false)
      for (let j = i + 1; j < routes.length; j++) expect(overlaps(box, labelBox(routes[j].label))).toBe(false)
    }
  })
  test('a manual label move changes text placement without rerouting the connector', () => {
    const automatic = routeEdges(nodes, [edge]).get(edge.id)!
    const moved = routeEdges(nodes, [{ ...edge, labelOffset: { x: 120, y: 70 } }]).get(edge.id)!
    expect(moved.path).toBe(automatic.path)
    expect(moved.label).toEqual({ x: moved.anchor.x + 120, y: moved.anchor.y + 70 })
  })
  test('routes around a node between the endpoints', () => {
    const blocker = { id: 'c', x: 300, y: -40, width: 180, height: 160 }
    const route = routeEdges([...nodes, blocker], [edge]).get(edge.id)!
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1], b = route.points[i]
      if (a.y === b.y && a.y > blocker.y && a.y < blocker.y + blocker.height) {
        expect(Math.max(a.x, b.x) <= blocker.x || Math.min(a.x, b.x) >= blocker.x + blocker.width).toBe(true)
      }
      if (a.x === b.x && a.x > blocker.x && a.x < blocker.x + blocker.width) {
        expect(Math.max(a.y, b.y) <= blocker.y || Math.min(a.y, b.y) >= blocker.y + blocker.height).toBe(true)
      }
    }
  })
  test('taking control of an automatic bend does not move the route', () => {
    const boxes = [...nodes, { id: 'blocker', x: 300, y: -40, width: 180, height: 160 }]
    const automatic = routeEdges(boxes, [edge]).get(edge.id)!
    const bend = automatic.bend!
    const pinned = routeEdges(boxes, [{ ...edge, bendAxis: bend.axis, bendOffset: bend.offset }]).get(edge.id)!
    expect(pinned.path).toBe(automatic.path)
    const saved = flowEdgeToDiagram(toFlowEdges([{ ...edge, bendAxis: bend.axis, bendOffset: bend.offset }], {})[0])
    expect(saved.bendAxis).toBe(bend.axis)
    expect(saved.bendOffset).toBe(bend.offset)
  })
  test('dense long labels stay separate in each layout direction', () => {
    for (const direction of ['LR', 'RL', 'TB', 'BT'] as const) {
      const doc = applyLayout({ nodes: Array.from({ length: 8 }, (_, i) => ({ id: String(i), label: 'Service' })), edges: Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, source: '0', target: String(i + 1), label: 'A long description of the connection and its contents' })) }, direction)
      const boxes = doc.nodes.map(n => ({ id: n.id, ...n.position!, width: 192, height: 80 }))
      const routes = [...routeEdges(boxes, doc.edges.map(e => ({ ...e, labelSize: { width: 180, height: 24 } }))).values()]
      for (let i = 0; i < routes.length; i++) for (let j = i + 1; j < routes.length; j++) expect(overlaps(labelBox(routes[i].label), labelBox(routes[j].label))).toBe(false)
    }
  })
  test('long parallel labels reserve space regardless of edge insertion order', () => {
    const layout = (labels: string[]) => applyLayout({ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: labels.map((label, i) => ({ id: String(i), source: 'a', target: 'b', label })) }).nodes[1].position!.x
    expect(layout(['long description of a request', 'x'])).toBe(layout(['x', 'long description of a request']))
  })
  test('label placement survives save/load and flow conversion', () => {
    const doc = parseDiagram(serializeDiagram({ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ ...edge, labelOffset: { x: 35, y: -21 } }] }))
    expect(flowEdgeToDiagram(toFlowEdges(doc.edges, {})[0]).labelOffset).toEqual({ x: 35, y: -21 })
    expect(parseDiagram(JSON.stringify({ ...doc, edges: [{ ...edge, labelOffset: { x: 'bad', y: 0 } }] })).edges[0].labelOffset).toBeUndefined()
  })
})
const node = (id: string, x: number, y: number, width = 100): Node => ({ id, position: { x, y }, selected: true, width, height: 60, data: { label: id } })
describe('selection arrangement', () => {
  test('alignment uses absolute positions across groups', () => {
    const group = { ...node('group', 400, 300), selected: false, data: { group: true } }
    const arranged = arrangeNodes([group, { ...node('child', 20, 30), parentId: 'group' }, node('free', 100, 200)], 'left')
    expect(arranged[1].position.x + group.position.x).toBe(100)
    expect(arranged[2].position.x).toBe(100)
  })
  test('selected children move with the selected group only once', () => {
    const group = { ...node('group', 100, 0), data: { group: true } }
    const child = { ...node('child', 20, 30), parentId: 'group' }
    expect(arrangementSelection([group, child, node('free', 0, 0)]).map(n => n.id)).toEqual(['group', 'free'])
    expect(arrangeNodes([group, child, node('free', 0, 0)], 'left')[1]).toBe(child)
  })
  test('distribution uses equal empty gaps for unequal card widths', () => {
    const arranged = arrangeNodes([node('a', 0, 0, 100), node('b', 200, 0, 200), node('c', 700, 0, 100)], 'horizontal')
    expect(arranged[1].position.x - 100).toBe(arranged[2].position.x - arranged[1].position.x - 200)
    expect(arranged[2].position.x).toBe(700)
  })
  test('matching widths leaves unselected nodes alone', () => {
    const unselected = { ...node('c', 0, 100, 300), selected: false }
    const arranged = arrangeNodes([node('a', 0, 0, 100), node('b', 200, 0, 200), unselected], 'width')
    expect(arranged[0].width).toBe(200)
    expect(arranged[2]).toBe(unselected)
  })
})
test('export bounds include labels outside nodes at any viewport zoom', () => {
  expect(includeRenderedBounds({ x: 0, y: 0, width: 700, height: 200 }, [{ x: 650, y: 100, width: 100, height: 20 }], { x: -50, y: 50 }, 0.5)).toEqual({ x: 0, y: 0, width: 1600, height: 200 })
})
test('search includes entity fields and edge labels and wraps both ways', () => {
  const matches = searchDiagram({ nodes: [{ id: 'a', label: 'A', fields: [{ name: 'account_id' }] }, { id: 'b', label: 'B' }], edges: [{ id: 'ab', source: 'a', target: 'b', label: 'account lookup' }] }, 'account')
  expect(matches.map(m => m.kind)).toEqual(['node', 'edge'])
  expect(matches[1].nodeIds).toEqual(['a', 'b'])
  expect(nextSearchIndex(0, 2, -1)).toBe(1)
  expect(nextSearchIndex(1, 2, 1)).toBe(0)
  expect(searchDiagram({ nodes: [], edges: [] }, ' ')).toEqual([])
})
