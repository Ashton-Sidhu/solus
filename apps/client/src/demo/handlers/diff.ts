import type { DiffRequest } from '@solus/contracts/git-types'
import type { IpcContext } from '@solus/contracts/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

export function registerDiffHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('diff', (args) => store.diff(args[0] as IpcContext, args[1] as DiffRequest))
  backend.register('diffStats', (args) => store.diffStats(args[0] as IpcContext, args[1] as DiffRequest))
  backend.register('listTurnSnapshots', (args) => store.turnSnapshots(args[0] as IpcContext))
  backend.register('gitRefreshState', () => store.gitStatus())
  backend.register('worktreeListProject', () => store.worktrees())
}
