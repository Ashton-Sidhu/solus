import type { IntroduceAction } from './fleet-reach'
import type { SceneRect } from './fleet-view'

/**
 * The line a dragged handle draws, in the map's own px: it leaves the handle the
 * way the handle faces, as a line in a node editor does, and snaps to the nearest
 * edge of a host or a found machine a drop would act on.
 */

export interface DragPoint { x: number; y: number }

/** A unit direction: the way a line leaves a handle, or enters an edge. */
export interface DragNormal { x: -1 | 0 | 1; y: -1 | 0 | 1 }

export interface DragSnap {
  point: DragPoint
  /** Outward from the edge: the line comes in against it. */
  normal: DragNormal
}

/** The middle of the edge of `rect` nearest `from`, and its outward direction: where a line from `from` meets it. */
export function snapPoint(from: DragPoint, rect: SceneRect): DragSnap {
  const edges: DragSnap[] = [
    { point: { x: rect.x, y: rect.y + rect.h / 2 }, normal: { x: -1, y: 0 } },
    { point: { x: rect.x + rect.w, y: rect.y + rect.h / 2 }, normal: { x: 1, y: 0 } },
    { point: { x: rect.x + rect.w / 2, y: rect.y }, normal: { x: 0, y: -1 } },
    { point: { x: rect.x + rect.w / 2, y: rect.y + rect.h }, normal: { x: 0, y: 1 } },
  ]
  const distance = (edge: DragSnap) => Math.hypot(edge.point.x - from.x, edge.point.y - from.y)
  return edges.reduce((nearest, edge) => (distance(edge) < distance(nearest) ? edge : nearest))
}

/**
 * Where the line leaves the source: the side of its box that faces `toward` when
 * that lies wholly to its left or right, else the side its handle is on. So a
 * line never starts on the far side of its own card and crosses it.
 */
export function dragStart(source: SceneRect, handleSide: 'left' | 'bottom', toward: DragPoint): DragSnap {
  const middle = source.y + source.h / 2
  if (toward.x > source.x + source.w) return { point: { x: source.x + source.w, y: middle }, normal: { x: 1, y: 0 } }
  if (toward.x < source.x || handleSide === 'left') return { point: { x: source.x, y: middle }, normal: { x: -1, y: 0 } }
  return { point: { x: source.x + source.w / 2, y: source.y + source.h }, normal: { x: 0, y: 1 } }
}

/**
 * A cubic from a handle to a point, as a line in a node editor draws it: it leaves
 * the handle along `exit` and, when it is snapped to an edge, enters that edge
 * along its normal. The bend grows with the distance and stays between bounds, so
 * two cards one above the other get a soft arc beside them, not a line across one.
 */
export function dragCurve(from: DragPoint, exit: DragNormal, to: DragPoint, entry: DragNormal | null): string {
  const reach = Math.min(120, Math.max(28, Math.hypot(to.x - from.x, to.y - from.y) * 0.4))
  const c1 = { x: from.x + exit.x * reach, y: from.y + exit.y * reach }
  // A free end has no edge: the curve eases into the pointer.
  const c2 = entry ? { x: to.x + entry.x * reach, y: to.y + entry.y * reach } : to
  const n = (value: number) => Math.round(value * 10) / 10
  return `M ${n(from.x)} ${n(from.y)} C ${n(c1.x)} ${n(c1.y)}, ${n(c2.x)} ${n(c2.y)}, ${n(to.x)} ${n(to.y)}`
}

export type DragTone = 'ok' | 'no' | 'none'

export interface DragHint {
  text: string
  tone: DragTone
}

/**
 * What a drop where the pointer is would do, in a few words, for the label that
 * follows the pointer: introduce, add, why not, or where a drop is taken.
 */
export function dragHint(input: {
  action: IntroduceAction | null
  foundName: string | null
  labelOf: (serverId: string) => string
}): DragHint {
  const { action, foundName, labelOf } = input
  if (foundName) return { text: `Add ${foundName}`, tone: 'ok' }
  if (action?.kind === 'introduce') {
    const names = action.targetIds.map(labelOf)
    const text = names.length <= 2 ? names.join(' and ') : `${names[0]} and ${names.length - 1} more`
    return { text: `Introduce to ${text}`, tone: 'ok' }
  }
  if (action?.kind === 'explain') return { text: 'Cannot introduce here', tone: 'no' }
  return { text: 'Drop on a host or a found machine', tone: 'none' }
}
