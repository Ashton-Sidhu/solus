import type { DiffRequest } from '../../../../src/shared/git-types'
import type { IpcContext } from '../../../../src/shared/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

export function registerDiffHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('diff', (args) => store.diff(args[0] as IpcContext, args[1] as DiffRequest))
  backend.register('diffStats', (args) => store.diffStats(args[0] as IpcContext, args[1] as DiffRequest))
  backend.register('listTurnSnapshots', (args) => store.turnSnapshots(args[0] as IpcContext))
  backend.register('gitProjectStatus', () => store.gitStatus())
  backend.register('worktreeListProject', () => store.worktrees())
}
