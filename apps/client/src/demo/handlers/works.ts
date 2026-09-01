import { arg, optionalArg } from './args'
import type { AgentId, Work, WorkAnnotations } from '@solus/contracts/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

export function registerWorksHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('listWorks', () => store.listWorks())
  backend.register('loadWork', (args) => store.loadWork(arg<string>(args, 0)))
  backend.register('saveWork', (args) => {
    const id = arg<string>(args, 0)
    const patch = arg<Partial<Pick<Work, 'title' | 'preview' | 'content'>>>(args, 1)
    return store.saveWork(id, patch)
  })
  backend.register('createWork', (args) => {
    const title = arg<string>(args, 0)
    const type = arg<Work['type']>(args, 1)
    const content = optionalArg<string>(args, 2)
    const preview = optionalArg<string>(args, 3)
    const sessionId = optionalArg<string>(args, 4)
    const agentProvider = arg<AgentId>(args, 5)
    const cwd = optionalArg<string>(args, 6)
    const id = optionalArg<string>(args, 7)
    return store.createWork(title, type, content, preview, sessionId, agentProvider, cwd, id)
  })
  backend.register('duplicateWork', (args) => store.duplicateWork(arg<string>(args, 0)))
  backend.register('deleteWork', (args) => store.deleteWork(arg<string>(args, 0)))
  backend.register('setWorkPinned', (args) => {
    const id = arg<string>(args, 0)
    const pinned = arg<boolean>(args, 1)
    store.setWorkPinned(id, pinned)
  })
  backend.register('loadWorkAnnotations', (args) => store.loadWorkAnnotations(arg<string>(args, 0)))
  backend.register('saveWorkAnnotations', (args) => store.saveWorkAnnotations(arg<WorkAnnotations>(args, 0)))
  backend.register('loadWorkPrevious', (args) => store.loadWorkPrevious(arg<string>(args, 0)))
  // The demo connects to nothing, so the publish menu shows the same "not
  // connected" answer a real host with no provider would give — an unhandled
  // method would hand the menu a null list instead.
  backend.register('docProviderStatuses', () => [
    // `connectable: false`: the demo has no host to sign in to, so a Connect
    // route would lead nowhere.
    { provider: 'confluence', connected: false, reason: 'No Atlassian site is connected.', connectable: false },
    { provider: 'gdrive', connected: false, reason: 'Google Drive is not connected.', connectable: false },
  ])
}
