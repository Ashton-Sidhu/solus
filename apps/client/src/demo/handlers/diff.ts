import { arg } from './args'
import type { DiffRequest } from '@solus/contracts/git-types'
import type { IpcContext } from '@solus/contracts/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

export function registerDiffHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('diff', (args) => store.diff(arg<IpcContext>(args, 0), arg<DiffRequest>(args, 1)))
  backend.register('diffStats', (args) => store.diffStats(arg<IpcContext>(args, 0), arg<DiffRequest>(args, 1)))
  backend.register('listTurnSnapshots', (args) => store.turnSnapshots(arg<IpcContext>(args, 0)))
  backend.register('gitRefreshState', () => store.gitStatus())
  backend.register('worktreeListProject', () => store.worktrees())
}
