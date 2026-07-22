import type { IpcContext } from '../../../shared/types'
import {
  addManualStackEdge,
  detectStackGraph,
  emptyStackGraph,
  readStackGraph,
  removeManualStackEdge,
} from '../../git/stack-detect'
import { resolveRepoRoot } from '../../git/git-helpers'
import type { Provider, RepoRef } from '../../providers/types'
import { reviewTargetFor } from './provider-handlers'
import type { SolusServer } from '../server'

export function registerStackHandlers(server: SolusServer): void {
  server.register('stackGet', async (args) => {
    const [ctx] = args as [IpcContext]
    const repoRoot = await repoRootFor(ctx)
    return { repoRoot, graph: (await readStackGraph(repoRoot)) ?? emptyStackGraph() }
  })

  server.register('stackDetect', async (args) => {
    const [ctx] = args as [IpcContext]
    const { repoRoot, repo, provider } = await detectionTargetFor(ctx)
    const graph = await detectStackGraph({ repoRoot, repo, provider })
    server.broadcast('stack-graph-update', repoRoot, graph)
    return { repoRoot, graph }
  })

  server.register('stackAddManualEdge', async (args) => {
    const [ctx, parent, child] = args as [IpcContext, number, number]
    const { repoRoot, repo, provider } = await detectionTargetFor(ctx)
    let graph = await readStackGraph(repoRoot)
    if (!graph?.headShas[parent] || !graph.headShas[child]) {
      graph = await detectStackGraph({ repoRoot, repo, provider })
    }
    graph = await addManualStackEdge(repoRoot, parent, child)
    server.broadcast('stack-graph-update', repoRoot, graph)
    return graph
  })

  server.register('stackRemoveManualEdge', async (args) => {
    const [ctx, parent, child] = args as [IpcContext, number, number]
    const { repoRoot, repo, provider } = await detectionTargetFor(ctx)
    await removeManualStackEdge(repoRoot, parent, child)
    // Removing intent immediately exposes any still-live inferred relationship.
    const graph = await detectStackGraph({ repoRoot, repo, provider })
    server.broadcast('stack-graph-update', repoRoot, graph)
    return graph
  })
}

async function repoRootFor(ctx: IpcContext): Promise<string> {
  const cwd = ctx.session.projectPath || ctx.session.workingDirectory
  const repoRoot = cwd ? await resolveRepoRoot(cwd) : null
  if (!repoRoot) throw new Error('Stack detection requires a git repository.')
  return repoRoot
}

async function detectionTargetFor(ctx: IpcContext): Promise<{
  repoRoot: string
  repo: RepoRef
  provider: Provider
}> {
  const [{ repo, provider }, repoRoot] = await Promise.all([reviewTargetFor(ctx), repoRootFor(ctx)])
  return { repoRoot, repo, provider }
}
