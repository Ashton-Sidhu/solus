export interface AlignmentNode {
  id: string
  parentId?: string
  x: number
  y: number
  width: number
  height: number
  dragging?: boolean
  hidden?: boolean
}

export interface AlignmentGuide {
  axis: 'x' | 'y'
  position: number
  start: number
  end: number
}

type Bounds = Pick<AlignmentNode, 'x' | 'y' | 'width' | 'height'>

function ancestors(node: AlignmentNode, byId: Map<string, AlignmentNode>): Set<string> {
  const ids = new Set<string>()
  let parentId = node.parentId
  while (parentId && !ids.has(parentId)) {
    ids.add(parentId)
    parentId = byId.get(parentId)?.parentId
  }
  return ids
}

function selectionBounds(nodes: AlignmentNode[]): Bounds {
  const x = Math.min(...nodes.map(n => n.x)), y = Math.min(...nodes.map(n => n.y))
  return { x, y, width: Math.max(...nodes.map(n => n.x + n.width)) - x, height: Math.max(...nodes.map(n => n.y + n.height)) - y }
}

function anchors(box: Bounds, axis: 'x' | 'y'): number[] {
  const size = axis === 'x' ? box.width : box.height
  // Prefer centers when equally close, then the two boundaries.
  return [box[axis] + size / 2, box[axis], box[axis] + size]
}

function nearestGuide(moving: Bounds, references: AlignmentNode[], axis: 'x' | 'y', zoom: number): AlignmentGuide | undefined {
  const other = axis === 'x' ? 'y' : 'x', size = axis === 'x' ? 'height' : 'width'
  let bestDistance = 1 / zoom
  let guide: AlignmentGuide | undefined
  for (const node of references) {
    for (const position of anchors(node, axis)) {
      for (const movingPosition of anchors(moving, axis)) {
        const distance = Math.abs(position - movingPosition)
        if (distance > bestDistance || (guide && distance === bestDistance)) continue
        bestDistance = distance
        guide = { axis, position, start: Math.min(moving[other], node[other]) - 8 / zoom,
          end: Math.max(moving[other] + moving[size], node[other] + node[size]) + 8 / zoom }
      }
    }
  }
  return guide
}

/** Visual feedback within one screen pixel of alignment; never changes geometry. */
export function alignmentGuides(nodes: AlignmentNode[], viewportZoom: number): AlignmentGuide[] {
  const moving = nodes.filter(n => n.dragging && !n.hidden)
  if (!moving.length) return []
  const zoom = Math.max(0.01, viewportZoom)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const movingIds = new Set(moving.map(n => n.id))
  const parentIds = new Set(moving.flatMap(n => [...ancestors(n, byId)]))
  const references = nodes.filter(n => !n.hidden && !movingIds.has(n.id) && !parentIds.has(n.id) &&
    ![...ancestors(n, byId)].some(id => movingIds.has(id)))
  const bounds = selectionBounds(moving)
  return (['x', 'y'] as const).flatMap(axis => {
    const guide = nearestGuide(bounds, references, axis, zoom)
    return guide ? [guide] : []
  })
}
