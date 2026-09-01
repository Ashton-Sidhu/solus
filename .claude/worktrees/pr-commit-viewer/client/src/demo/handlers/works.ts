import type { AgentId, Work, WorkAnnotations } from '../../../../src/shared/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

export function registerWorksHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('listWorks', () => store.listWorks())
  backend.register('loadWork', (args) => store.loadWork(args[0] as string))
  backend.register('saveWork', (args) => {
    const [id, patch] = args as [string, Partial<Pick<Work, 'title' | 'preview' | 'content'>>]
    return store.saveWork(id, patch)
  })
  backend.register('createWork', (args) => {
    const [title, type, content, preview, sessionId, agentProvider, cwd, id] = args as [
      string,
      Work['type'],
      string | undefined,
      string | undefined,
      string | undefined,
      AgentId,
      string | undefined,
      string | undefined,
    ]
    return store.createWork(title, type, content, preview, sessionId, agentProvider, cwd, id)
  })
  backend.register('duplicateWork', (args) => store.duplicateWork(args[0] as string))
  backend.register('deleteWork', (args) => store.deleteWork(args[0] as string))
  backend.register('setWorkPinned', (args) => {
    const [id, pinned] = args as [string, boolean]
    store.setWorkPinned(id, pinned)
  })
  backend.register('loadWorkAnnotations', (args) => store.loadWorkAnnotations(args[0] as string))
  backend.register('saveWorkAnnotations', (args) => store.saveWorkAnnotations(args[0] as WorkAnnotations))
  backend.register('loadWorkPrevious', (args) => store.loadWorkPrevious(args[0] as string))
}
