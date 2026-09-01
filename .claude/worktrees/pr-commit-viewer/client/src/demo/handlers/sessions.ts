import type { PinnedSession } from '../../../../src/shared/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

const loadedSessions = new Set<string>()
const loadWaiters = new Map<string, Set<() => void>>()

export function whenSessionLoaded(sessionId: string): Promise<void> {
  if (loadedSessions.has(sessionId)) return Promise.resolve()
  return new Promise((resolve) => {
    let waiters = loadWaiters.get(sessionId)
    if (!waiters) {
      waiters = new Set()
      loadWaiters.set(sessionId, waiters)
    }
    waiters.add(resolve)
  })
}

function markSessionLoaded(sessionId: string): void {
  loadedSessions.add(sessionId)
  const waiters = loadWaiters.get(sessionId)
  if (!waiters) return
  for (const resolve of waiters) resolve()
  loadWaiters.delete(sessionId)
}

export function registerSessionsHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('listSessions', () => store.listSessions())
  backend.register('searchSessions', (args) => {
    const [request] = args as [{ query: string; projectPath?: string; limit?: number }]
    return store.searchSessions(request)
  })
  backend.register('loadSession', (args) => {
    const [sessionId, , , , limit] = args as [string, unknown, unknown, unknown, number | undefined]
    const messages = store.loadSession(sessionId, limit)
    markSessionLoaded(sessionId)
    return messages
  })
  backend.register('loadSessionPreview', (args) => store.loadSessionPreview(args[0] as string))
  backend.register('getSessionInfo', (args) => store.getSessionInfo(args[0] as string))
  backend.register('pinnedSessionsList', () => store.listPinnedSessions())
  backend.register('togglePinnedSession', (args) => store.togglePinnedSession(args[0] as PinnedSession))
}
