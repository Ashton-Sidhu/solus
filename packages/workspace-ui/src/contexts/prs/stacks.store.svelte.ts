import { SvelteMap } from 'svelte/reactivity'
import { resolveStackDiffBase, type DiffBase, type StackGraph } from '@solus/contracts/stack-types'
import type { IpcContext } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import { subscribeAllHosts } from '@solus/client-core/host-events'

export class StacksStore {
  graphs = new SvelteMap<string, StackGraph>()
  activeGraphKey = $state<string | null>(null)
  loading = $state(false)

  apply(serverId: string, repoRoot: string, graph: StackGraph): void {
    this.graphs.set(hostKey(serverId, repoRoot), graph)
  }

  subscribe(): () => void {
    return subscribeAllHosts('stack.graphChanged', (serverId, { repoRoot, graph }) => {
      this.apply(serverId, repoRoot, graph)
    })
  }

  async load(api: HostApi, serverId: string, ctx: IpcContext): Promise<StackGraph> {
    this.loading = true
    try {
      // SAFETY: the JSON round-trip only unwraps the Svelte proxy from this IpcContext.
      const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
      const snapshot = await api.stackGet(safeCtx)
      this.apply(serverId, snapshot.repoRoot, snapshot.graph)
      this.activeGraphKey = hostKey(serverId, snapshot.repoRoot)
      return snapshot.graph
    } finally {
      this.loading = false
    }
  }

  async detect(api: HostApi, serverId: string, ctx: IpcContext): Promise<StackGraph> {
    // SAFETY: the JSON round-trip only unwraps the Svelte proxy from this IpcContext.
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    const snapshot = await api.stackDetect(safeCtx)
    this.apply(serverId, snapshot.repoRoot, snapshot.graph)
    this.activeGraphKey = hostKey(serverId, snapshot.repoRoot)
    return snapshot.graph
  }

  graphFor(serverId: string, repoRoot: string): StackGraph | null {
    return this.graphs.get(hostKey(serverId, repoRoot)) ?? null
  }

  parentOf(prNumber: number, serverId: string, repoRoot: string): number | null {
    return this.graphFor(serverId, repoRoot)?.edges.find((edge) => edge.child === prNumber)?.parent ?? null
  }

  childrenOf(prNumber: number, serverId: string, repoRoot: string): number[] {
    return this.graphFor(serverId, repoRoot)?.edges
      .filter((edge) => edge.parent === prNumber)
      .map((edge) => edge.child)
      .sort((a, b) => a - b) ?? []
  }

  resolveDiffBase(prNumber: number, baseBranch: string, serverId: string, repoRoot: string): DiffBase {
    return resolveStackDiffBase(this.graphFor(serverId, repoRoot), prNumber, baseBranch)
  }
}
