import { SvelteMap } from 'svelte/reactivity'
import type { DiffBase, StackGraph } from '../../shared/stack-types'
import type { IpcContext } from '../../shared/types'
import { resolveStackDiffBase } from './stack-diff-base'

export class StacksStore {
  graphs = new SvelteMap<string, StackGraph>()
  activeRepoRoot = $state<string | null>(null)
  loading = $state(false)

  apply(repoRoot: string, graph: StackGraph): void {
    this.graphs.set(repoRoot, graph)
  }

  subscribe(): () => void {
    return window.solus.onStackGraphUpdate((repoRoot, graph) => this.apply(repoRoot, graph))
  }

  async load(ctx: IpcContext): Promise<StackGraph> {
    this.loading = true
    try {
      const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
      const snapshot = await window.solus.stackGet(safeCtx)
      this.apply(snapshot.repoRoot, snapshot.graph)
      this.activeRepoRoot = snapshot.repoRoot
      return snapshot.graph
    } finally {
      this.loading = false
    }
  }

  async detect(ctx: IpcContext): Promise<StackGraph> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    const snapshot = await window.solus.stackDetect(safeCtx)
    this.apply(snapshot.repoRoot, snapshot.graph)
    this.activeRepoRoot = snapshot.repoRoot
    return snapshot.graph
  }

  graphFor(repoRoot = this.activeRepoRoot): StackGraph | null {
    return repoRoot ? this.graphs.get(repoRoot) ?? null : null
  }

  parentOf(prNumber: number, repoRoot = this.activeRepoRoot): number | null {
    return this.graphFor(repoRoot)?.edges.find((edge) => edge.child === prNumber)?.parent ?? null
  }

  childrenOf(prNumber: number, repoRoot = this.activeRepoRoot): number[] {
    return this.graphFor(repoRoot)?.edges
      .filter((edge) => edge.parent === prNumber)
      .map((edge) => edge.child)
      .sort((a, b) => a - b) ?? []
  }

  resolveDiffBase(prNumber: number, baseBranch: string, repoRoot = this.activeRepoRoot): DiffBase {
    return resolveStackDiffBase(this.graphFor(repoRoot), prNumber, baseBranch)
  }
}
