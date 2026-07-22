import type { ReviewEffort } from '../../../../shared/effort-types'
import type { StackGraph } from '../../../../shared/stack-types'

export interface ReviewQueueItem {
  number: number
  effort?: ReviewEffort
}

interface RankedItem extends ReviewQueueItem {
  inputIndex: number
  baseRank: number
}

/**
 * Sorts by estimated minutes, with unknown estimates last and original input
 * order as the deterministic tie-break. A connected stack becomes one adjacent
 * unit anchored where its smallest-effort member would have appeared; inside
 * that unit, topological parent-before-child order wins over effort.
 */
export function orderReviewQueue(items: ReviewQueueItem[], stackGraph: StackGraph | null): ReviewQueueItem[] {
  const ranked = items
    .map((item, inputIndex) => ({ ...item, inputIndex, baseRank: -1 }))
    .sort((left, right) => {
      const leftMinutes = left.effort?.minutes ?? Number.POSITIVE_INFINITY
      const rightMinutes = right.effort?.minutes ?? Number.POSITIVE_INFINITY
      return leftMinutes - rightMinutes || left.inputIndex - right.inputIndex
    })
    .map((item, baseRank) => ({ ...item, baseRank }))

  if (!stackGraph || stackGraph.edges.length === 0) return ranked.map(toQueueItem)

  const byNumber = new Map(ranked.map((item) => [item.number, item]))
  const neighbours = new Map<number, Set<number>>()
  const relevantEdges = stackGraph.edges.filter((edge) => {
    if (edge.parent === edge.child || !byNumber.has(edge.parent) || !byNumber.has(edge.child)) return false
    if (!neighbours.has(edge.parent)) neighbours.set(edge.parent, new Set())
    if (!neighbours.has(edge.child)) neighbours.set(edge.child, new Set())
    neighbours.get(edge.parent)?.add(edge.child)
    neighbours.get(edge.child)?.add(edge.parent)
    return true
  })

  const componentByNumber = new Map<number, number>()
  const components: RankedItem[][] = []
  for (const item of ranked) {
    if (!neighbours.has(item.number) || componentByNumber.has(item.number)) continue
    const componentIndex = components.length
    const component: RankedItem[] = []
    const queue = [item.number]
    componentByNumber.set(item.number, componentIndex)
    while (queue.length > 0) {
      const number = queue.shift() as number
      component.push(byNumber.get(number) as RankedItem)
      for (const neighbour of neighbours.get(number) ?? []) {
        if (componentByNumber.has(neighbour)) continue
        componentByNumber.set(neighbour, componentIndex)
        queue.push(neighbour)
      }
    }
    components.push(component)
  }

  const units: Array<{ anchor: number; items: RankedItem[] }> = []
  for (const component of components) {
    units.push({
      anchor: Math.min(...component.map((item) => item.baseRank)),
      items: orderStack(component, relevantEdges),
    })
  }
  for (const item of ranked) {
    if (!componentByNumber.has(item.number)) units.push({ anchor: item.baseRank, items: [item] })
  }

  units.sort((left, right) => left.anchor - right.anchor)
  return units.flatMap((unit) => unit.items.map(toQueueItem))
}

function orderStack(items: RankedItem[], edges: StackGraph['edges']): RankedItem[] {
  const numbers = new Set(items.map((item) => item.number))
  const itemByNumber = new Map(items.map((item) => [item.number, item]))
  const indegree = new Map(items.map((item) => [item.number, 0]))
  const children = new Map<number, number[]>()

  for (const edge of edges) {
    if (!numbers.has(edge.parent) || !numbers.has(edge.child)) continue
    const existing = children.get(edge.parent) ?? []
    if (existing.includes(edge.child)) continue
    existing.push(edge.child)
    children.set(edge.parent, existing)
    indegree.set(edge.child, (indegree.get(edge.child) ?? 0) + 1)
  }

  const byBaseRank = (left: number, right: number) =>
    (itemByNumber.get(left)?.baseRank ?? 0) - (itemByNumber.get(right)?.baseRank ?? 0)
  const ready = items.filter((item) => indegree.get(item.number) === 0).map((item) => item.number).sort(byBaseRank)
  const ordered: RankedItem[] = []

  while (ready.length > 0) {
    const number = ready.shift() as number
    ordered.push(itemByNumber.get(number) as RankedItem)
    for (const child of children.get(number) ?? []) {
      const remaining = (indegree.get(child) ?? 0) - 1
      indegree.set(child, remaining)
      if (remaining === 0) {
        ready.push(child)
        ready.sort(byBaseRank)
      }
    }
  }

  // A malformed cyclic graph must still yield every PR in stable effort order.
  if (ordered.length < items.length) {
    const emitted = new Set(ordered.map((item) => item.number))
    ordered.push(...items.filter((item) => !emitted.has(item.number)).sort((a, b) => a.baseRank - b.baseRank))
  }
  return ordered
}

function toQueueItem(item: RankedItem): ReviewQueueItem {
  return item.effort ? { number: item.number, effort: item.effort } : { number: item.number }
}
