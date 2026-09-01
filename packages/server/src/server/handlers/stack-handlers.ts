import type { IpcContext } from '@solus/contracts/types'
import {
  addManualStackEdge,
  detectStackGraph,
  emptyStackGraph,
  readStackGraph,
  removeManualStackEdge,
} from '../../git/stack-detect'
import { requireRepoRoot } from '../../git/ctx-paths'
import type { Provider, RepoRef } from '../../providers/types'
import { reviewTargetFor } from './provider-handlers'
import type { SolusServer } from '../server'
import type { HostEventPublisher } from '../../events/host-event-publisher'

const NEEDS_REPOSITORY = 'Stack detection requires a git repository.'

export function registerStackHandlers(server: SolusServer, events: HostEventPublisher): void {
  server.register('stackGet', async (args) => {
    const [ctx] = args
    const repoRoot = await requireRepoRoot(ctx, NEEDS_REPOSITORY)
    if (!ctx.settings.stackedPrsEnabled) return { repoRoot, graph: emptyStackGraph() }
    return { repoRoot, graph: (await readStackGraph(repoRoot)) ?? emptyStackGraph() }
  })

  server.register('stackDetect', async (args) => {
    const [ctx] = args
    if (!ctx.settings.stackedPrsEnabled) {
      return { repoRoot: await requireRepoRoot(ctx, NEEDS_REPOSITORY), graph: emptyStackGraph() }
    }
    const { repoRoot, repo, provider } = await detectionTargetFor(ctx)
    const graph = await detectStackGraph({ repoRoot, repo, provider })
    events.broadcast('stack.graphChanged', { repoRoot, graph })
    return { repoRoot, graph }
  })

  server.register('stackAddManualEdge', async (args) => {
    const [ctx, parent, child] = args
    if (!ctx.settings.stackedPrsEnabled) throw new Error('Stacked pull requests are disabled.')
    const { repoRoot, repo, provider } = await detectionTargetFor(ctx)
    let graph = await readStackGraph(repoRoot)
    if (!graph?.headShas[parent] || !graph.headShas[child]) {
      graph = await detectStackGraph({ repoRoot, repo, provider })
    }
    graph = await addManualStackEdge(repoRoot, parent, child)
    events.broadcast('stack.graphChanged', { repoRoot, graph })
    return graph
  })

  server.register('stackRemoveManualEdge', async (args) => {
    const [ctx, parent, child] = args
    if (!ctx.settings.stackedPrsEnabled) throw new Error('Stacked pull requests are disabled.')
    const { repoRoot, repo, provider } = await detectionTargetFor(ctx)
    await removeManualStackEdge(repoRoot, parent, child)
    // Removing intent immediately exposes any still-live inferred relationship.
    const graph = await detectStackGraph({ repoRoot, repo, provider })
    events.broadcast('stack.graphChanged', { repoRoot, graph })
    return graph
  })
}

async function detectionTargetFor(ctx: IpcContext): Promise<{
  repoRoot: string
  repo: RepoRef
  provider: Provider
}> {
  const [{ repo, provider }, repoRoot] = await Promise.all([
    reviewTargetFor(ctx),
    requireRepoRoot(ctx, NEEDS_REPOSITORY),
  ])
  return { repoRoot, repo, provider }
}
