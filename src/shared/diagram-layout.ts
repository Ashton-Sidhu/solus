import dagre from '@dagrejs/dagre'
import type { DiagramDoc, DiagramEdge, DiagramNode } from './diagram-types'

// Clearance reserved for a group's header bar and the padding around its
// children when a group is sized to fit its contents.
const GROUP_HEADER = 48
const GROUP_PAD = 24

// The four dagre flow directions exposed to users as layout options.
//   LR — left → right (horizontal, the default)
//   TB — top → bottom (vertical)
//   RL — right → left
//   BT — bottom → top
export type LayoutDirection = 'LR' | 'TB' | 'RL' | 'BT'

// Per-field row height in the always-visible entity table (matches the
// 0.625rem/1.5 line plus row gap in DiagramNode.svelte).
const FIELD_ROW_H = 18

// Approximate the rendered card dimensions, mirroring DiagramNode.svelte's
// layout. Expanded-only content (metrics/tags/body) is collapsed at layout
// time and excluded. Width is clamped to the card's [min-width:12rem /
// max-width:18rem] range (192–288px); entities (nodes with `fields`) carry
// `name : type` rows that are wider, so they get a roomier max.
function estimateNodeSize(node: DiagramNode): { w: number; h: number } {
  const isEntity = !!node.fields?.length && !node.group
  let contentPx = node.label.length * 7 + 56  // 56px: icon (24) + gaps + horizontal padding
  if (isEntity) {
    // Widest field row: key glyph (~26) + name + type + ref + horizontal padding.
    for (const f of node.fields!) {
      const row =
        26 +
        f.name.length * 6 +
        (f.type ? f.type.length * 6 + 8 : 0) +
        (f.ref ? f.ref.length * 5 + 14 : 0) +
        24
      contentPx = Math.max(contentPx, row)
    }
  }
  const w = Math.max(192, Math.min(isEntity ? 360 : 288, contentPx))

  let h = 56  // header row base
  if (node.subtitle) h += 16
  if (node.badges?.length) h += 22
  if (isEntity) h += 10 + node.fields!.length * FIELD_ROW_H  // table-header pad + rows
  if (node.meta) h += Object.keys(node.meta).length * 14

  return { w, h }
}

// Run dagre over a node subset, returning each node's top-left position. Edges
// whose endpoints fall outside the subset are ignored so a group's internal
// layout only considers its own children.
function layoutSubset(
  subset: DiagramNode[],
  edges: DiagramEdge[],
  direction: LayoutDirection,
  sizeOf: (n: DiagramNode) => { w: number; h: number },
): Map<string, { x: number; y: number }> {
  const horizontal = direction === 'LR' || direction === 'RL'
  const ids = new Set(subset.map((n) => n.id))

  const g = new dagre.graphlib.Graph()
  // nodesep = gap between nodes within a rank, ranksep = gap between ranks.
  // Keep both generous so edge labels (placed mid-edge) don't collide with
  // neighbouring nodes. acyclicer:'greedy' removes feedback edges with a
  // minimal feedback-arc set so cycles (e.g. service→user response edges)
  // don't randomise which node becomes rank-0.
  g.setGraph({ rankdir: direction, nodesep: 120, ranksep: 140, edgesep: 40, acyclicer: 'greedy' })
  g.setDefaultEdgeLabel(() => ({}))

  // Insert nodes sorted by in-degree ascending (sources first) so dagre
  // tie-breaks rank-0 toward the true entry rather than insertion order.
  const indegree = new Map<string, number>()
  for (const node of subset) indegree.set(node.id, 0)
  for (const edge of edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) {
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    }
  }
  const sorted = [...subset].sort((a, b) => (indegree.get(a.id) ?? 0) - (indegree.get(b.id) ?? 0))

  for (const node of sorted) {
    const { w, h } = sizeOf(node)
    g.setNode(node.id, { width: w, height: h })
  }
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue
    // Reserve space for the label so dagre widens the gap between ranks to fit
    // the text instead of letting it overlap nodes. Ranks separate along the
    // flow axis, so the label's size on that axis (width when horizontal,
    // height when vertical) is what pushes the ranks apart.
    const label = edge.label?.trim()
    if (!label) {
      g.setEdge(edge.source, edge.target, {})
      continue
    }
    g.setEdge(
      edge.source,
      edge.target,
      horizontal
        ? { width: label.length * 7 + 16, height: 24, labelpos: 'c' }
        : { width: 24, height: 40, labelpos: 'c' },
    )
  }

  dagre.layout(g)

  const out = new Map<string, { x: number; y: number }>()
  for (const node of subset) {
    const { x, y } = g.node(node.id)
    const { w, h } = sizeOf(node)
    out.set(node.id, { x: x - w / 2, y: y - h / 2 })
  }
  return out
}

export function applyLayout(doc: DiagramDoc, direction: LayoutDirection = 'LR'): DiagramDoc {
  const needsLayout = doc.nodes.some((n) => !n.position)
  if (!needsLayout) return doc

  const groupIds = new Set(doc.nodes.filter((n) => n.group).map((n) => n.id))
  const childrenByGroup = new Map<string, DiagramNode[]>()
  for (const n of doc.nodes) {
    if (n.parentId && groupIds.has(n.parentId)) {
      const list = childrenByGroup.get(n.parentId)
      if (list) list.push(n)
      else childrenByGroup.set(n.parentId, [n])
    }
  }

  // Depth of a group in the nesting tree (0 = top level), so we can size the
  // innermost groups first and feed their fitted box up to their parents.
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const groupDepth = (id: string): number => {
    let depth = 0
    let pid = byId.get(id)?.parentId
    while (pid) {
      depth++
      pid = byId.get(pid)?.parentId
    }
    return depth
  }
  // Deepest groups first so a nested group's fitted size is known when its
  // parent group is laid out.
  const orderedGroupIds = [...groupIds].sort((a, b) => groupDepth(b) - groupDepth(a))

  // Step 1 — lay each group's children out on their own and size the group to
  // fit them (plus header + padding). Children sit below the header bar. A
  // nested group counts against its parent at its own fitted size, not a leaf
  // estimate, so the parent grows to actually contain it.
  const childRel = new Map<string, { x: number; y: number }>()
  const groupSize = new Map<string, { w: number; h: number }>()
  const sizeFor = (n: DiagramNode): { w: number; h: number } =>
    n.group && groupSize.has(n.id) ? groupSize.get(n.id)! : estimateNodeSize(n)
  for (const id of orderedGroupIds) {
    const group = doc.nodes.find((n) => n.id === id)!
    const kids = childrenByGroup.get(id) ?? []
    if (!kids.length) {
      groupSize.set(id, { w: group.width ?? 320, h: group.height ?? 220 })
      continue
    }
    const pos = layoutSubset(kids, doc.edges, direction, sizeFor)
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const k of kids) {
      const p = pos.get(k.id)!
      const { w: kw, h: kh } = sizeFor(k)
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + kw)
      maxY = Math.max(maxY, p.y + kh)
    }
    const w = group.width ?? maxX - minX + GROUP_PAD * 2
    const h = group.height ?? maxY - minY + GROUP_PAD * 2 + GROUP_HEADER
    groupSize.set(id, { w, h })
    for (const k of kids) {
      const p = pos.get(k.id)!
      childRel.set(k.id, { x: p.x - minX + GROUP_PAD, y: p.y - minY + GROUP_PAD + GROUP_HEADER })
    }
  }

  // Step 2 — lay the top level out, treating each group as one sized box.
  const topLevel = doc.nodes.filter((n) => !n.parentId)
  const topPos = layoutSubset(topLevel, doc.edges, direction, sizeFor)

  // Step 3 — assemble. Existing positions are preserved; only missing ones are
  // filled. Groups carry their fitted size (nested groups included); children
  // carry their parent-relative position; top-level nodes their dagre position.
  const nodes: DiagramNode[] = doc.nodes.map((node) => {
    const size = node.group ? groupSize.get(node.id) : undefined
    const sized =
      size && (node.width === undefined || node.height === undefined)
        ? { ...node, width: node.width ?? size.w, height: node.height ?? size.h }
        : node
    if (sized.position) return sized
    if (node.parentId && groupIds.has(node.parentId)) {
      const rel = childRel.get(node.id) ?? { x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER }
      return { ...sized, position: rel }
    }
    const p = topPos.get(node.id) ?? { x: 0, y: 0 }
    return { ...sized, position: p }
  })

  return { nodes, edges: doc.edges }
}
