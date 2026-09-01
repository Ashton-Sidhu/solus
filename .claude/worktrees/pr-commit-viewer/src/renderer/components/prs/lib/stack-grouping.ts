import type { StackGraph } from '../../../../shared/stack-types'

export interface StackedPrRow<T extends { number: number }> {
  pr: T
  depth: number
  parent: number | null
}

/** Preserve the active list sort while placing each valid child immediately
 * under its parent. Broken relationships stay flat so advisory stack data can
 * never hide a PR or trap the renderer in a cycle. */
export function groupStackedPrRows<T extends { number: number }>(
  prs: readonly T[],
  graph: StackGraph | null,
): StackedPrRow<T>[] {
  if (!graph || graph.edges.length === 0) return prs.map((pr) => ({ pr, depth: 0, parent: null }))

  const byNumber = new Map(prs.map((pr) => [pr.number, pr]))
  const candidateParents = new Map<number, number>()
  for (const edge of graph.edges) {
    if (edge.parent === edge.child || !byNumber.has(edge.parent) || !byNumber.has(edge.child)) continue
    if (!candidateParents.has(edge.child)) candidateParents.set(edge.child, edge.parent)
  }

  const parentByChild = new Map<number, number>()
  for (const [child, parent] of candidateParents) {
    if (!walksIntoCycle(child, candidateParents)) parentByChild.set(child, parent)
  }

  const childrenByParent = new Map<number, number[]>()
  for (const pr of prs) {
    const parent = parentByChild.get(pr.number)
    if (parent === undefined) continue
    const children = childrenByParent.get(parent) ?? []
    children.push(pr.number)
    childrenByParent.set(parent, children)
  }

  const rows: StackedPrRow<T>[] = []
  const visited = new Set<number>()
  const append = (number: number, depth: number, parent: number | null): void => {
    if (visited.has(number)) return
    const pr = byNumber.get(number)
    if (!pr) return
    visited.add(number)
    rows.push({ pr, depth, parent })
    for (const child of childrenByParent.get(number) ?? []) append(child, depth + 1, number)
  }

  for (const pr of prs) {
    if (!parentByChild.has(pr.number)) append(pr.number, 0, null)
  }
  for (const pr of prs) append(pr.number, 0, null)
  return rows
}

/** The compact detail-rail path through the current PR. Descendants extend only
 * while the relationship remains a chain; a fork has no honest single arrow. */
export function stackChainFor(graph: StackGraph | null, current: number): number[] {
  if (!graph || graph.edges.length === 0) return [current]

  const parentByChild = new Map<number, number>()
  const childrenByParent = new Map<number, number[]>()
  for (const edge of graph.edges) {
    if (edge.parent === edge.child || parentByChild.has(edge.child)) continue
    parentByChild.set(edge.child, edge.parent)
    const children = childrenByParent.get(edge.parent) ?? []
    children.push(edge.child)
    childrenByParent.set(edge.parent, children)
  }
  if (walksIntoCycle(current, parentByChild)) return [current]

  const chain = [current]
  const seen = new Set(chain)
  let cursor = current
  while (parentByChild.has(cursor)) {
    const parent = parentByChild.get(cursor)!
    if (seen.has(parent)) return [current]
    chain.unshift(parent)
    seen.add(parent)
    cursor = parent
  }

  cursor = current
  while (true) {
    const children = (childrenByParent.get(cursor) ?? []).filter((child) => !seen.has(child))
    if (children.length !== 1) break
    chain.push(children[0])
    seen.add(children[0])
    cursor = children[0]
  }
  return chain
}

function walksIntoCycle(start: number, parentByChild: ReadonlyMap<number, number>): boolean {
  const seen = new Set<number>()
  let cursor: number | undefined = start
  while (cursor !== undefined) {
    if (seen.has(cursor)) return true
    seen.add(cursor)
    cursor = parentByChild.get(cursor)
  }
  return false
}
