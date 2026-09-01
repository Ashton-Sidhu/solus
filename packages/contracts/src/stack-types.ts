/** How an edge was found. Ordered by confidence — `ancestry` is a git fact;
 *  `patchid` is a heuristic for rebased/cherry-picked chains and is the reason
 *  #17 refuses to hard-gate on stack membership (a wrong edge must never block
 *  a reviewer). */
export type StackEdgeSource = 'ancestry' | 'patchid' | 'declared' | 'manual'

export interface StackEdge {
  /** The PR `child` is branched off. */
  parent: number
  child: number
  source: StackEdgeSource
}

/** Persisted verbatim as `.solus/stacks.json`, per repo. */
export interface StackGraph {
  edges: StackEdge[]
  /** Head sha per PR at detection time. An edge is invalid once either end's head
   *  moves (7a: invalidate per edge when either head moves) — so a force-push
   *  re-triggers detection instead of leaving a stale edge. */
  headShas: Record<number, string>
  detectedAt: string
}

/** What a child's diff is taken against. RECOMPUTED from the live graph on every
 *  read — never persisted, never stamped on an approval (#21). Own-delta is not a
 *  property of being stacked; it is what you get once the parent is dealt with
 *  (#17). Edges exist only among OPEN PRs, so a closed parent makes the edge
 *  vanish and the child becomes `target` — "treat it as if A never existed". */
export interface DiffBase {
  kind: 'own-delta' | 'target'
  /** parent_head for 'own-delta'; the PR's base branch for 'target'. */
  ref: string
  /** Set only for 'own-delta' — drives #17's banner copy ("…on top of #A"). */
  parent?: number
}

/** Resolve against the live graph so closing a parent immediately restores the target base. */
export function resolveStackDiffBase(graph: StackGraph | null, prNumber: number, baseBranch: string): DiffBase {
  const edge = graph?.edges.find((candidate) => candidate.child === prNumber)
  const parentHead = edge ? graph?.headShas[edge.parent] : undefined
  if (edge && parentHead) return { kind: 'own-delta', ref: parentHead, parent: edge.parent }
  return { kind: 'target', ref: baseBranch }
}
