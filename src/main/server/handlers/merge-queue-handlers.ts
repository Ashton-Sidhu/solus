import type { IpcContext, MergeQueueStartItem, MergeQueueStartOptions, MergeQueueStartResult, MergeQueueState } from '../../../shared/types'
import { resolveRepoRoot } from '../../git/git-helpers'
import { getActiveMergeQueue, startMergeQueue } from '../../git/merge-queue'
import { createLogger } from '../../logger'
import { reviewTargetFor } from './provider-handlers'
import type { SolusServer } from '../server'

const log = createLogger('main', 'merge-queue-handlers')

export function registerMergeQueueHandlers(server: SolusServer): void {
  server.register('mergeQueueStart', async (args): Promise<MergeQueueStartResult> => {
    const [ctx, items, options] = args as [IpcContext, MergeQueueStartItem[], MergeQueueStartOptions]
    log.info(`RPC mergeQueueStart: ${items.length} PRs, order=${options.order}`)
    if (items.length === 0) return { success: false, error: 'No pull requests queued' }
    try {
      const { repo, provider } = await reviewTargetFor(ctx)
      const base = ctx.session.projectPath || ctx.session.workingDirectory
      const repoRoot = base ? await resolveRepoRoot(base) : null
      if (!repoRoot) return { success: false, error: 'Not a git repository' }
      startMergeQueue(
        { repoRoot, repo, provider, onUpdate: (state) => server.broadcast('merge-queue-update', state) },
        items,
        options,
      )
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? 'Could not start the merge queue' }
    }
  })

  // Snapshot for late-joining renderers (page reopen, web client reconnect).
  server.register('mergeQueueState', async (): Promise<MergeQueueState | null> => {
    return getActiveMergeQueue()?.getState() ?? null
  })

  server.register('mergeQueueSkip', async () => {
    getActiveMergeQueue()?.skipCurrent()
  })

  server.register('mergeQueueCancel', async () => {
    getActiveMergeQueue()?.cancel()
  })
}
