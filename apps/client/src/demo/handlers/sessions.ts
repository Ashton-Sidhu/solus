import { arg, optionalArg } from './args'
import type { SessionMessageWindowRequest } from '@solus/contracts/session-history'
import type { PinnedSession } from '@solus/contracts/types'
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
    const request = arg<{ query: string; projectPath?: string; limit?: number }>(args, 0)
    return store.searchSessions(request)
  })
  backend.register('loadSession', (args) => {
    const sessionId = arg<string>(args, 0)
    const limit = optionalArg<number>(args, 4)
    const messages = store.loadSession(sessionId, limit)
    markSessionLoaded(sessionId)
    return messages
  })
  backend.register('loadSessionPreview', (args) => store.loadSessionPreview(arg<string>(args, 0)))
  backend.register('loadSessionMessageWindow', (args) =>
    store.loadSessionMessageWindow(arg<SessionMessageWindowRequest>(args, 0)))
  backend.register('getSessionInfo', (args) => store.getSessionInfo(arg<string>(args, 0)))
  backend.register('getSessionInfos', (args) => arg<string[]>(args, 0).map((sessionId) => store.getSessionInfo(sessionId)))
  backend.register('pinnedSessionsList', () => store.listPinnedSessions())
  backend.register('togglePinnedSession', (args) => store.togglePinnedSession(arg<PinnedSession>(args, 0)))
}
