import { arg, optionalArg } from './args'
import type { SessionMessageWindowRequest } from '@solus/contracts/session-history'
import type { PinnedSession, SessionMeta, SessionRecord, SessionRecordSearchQuery } from '@solus/contracts/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

/** A fixture session as the record a host keeps for it. */
function demoSessionRecord(meta: SessionMeta): SessionRecord {
  const lastActivityAt = Date.parse(meta.lastTimestamp)
  return {
    sessionId: meta.sessionId, organizationId: 'local', publication: 'local', ownerUserId: null,
    provider: meta.provider, projectPath: meta.projectPath, projectRemote: null, runnerHostId: null,
    title: meta.firstMessage ?? meta.slug, customTitle: meta.customTitle ?? null,
    status: 'idle', model: meta.model ?? null, reasoningEffort: meta.reasoningEffort ?? null,
    parentSessionId: meta.delegation?.parentSessionId ?? null, rootSessionId: meta.delegation?.rootSessionId ?? null,
    createdAt: lastActivityAt, lastActivityAt, size: meta.size,
    cwd: meta.cwd || null, slug: meta.slug, isWorktree: meta.isWorktree ?? false,
    branch: meta.branch ?? null, projectRoot: meta.projectRoot ?? null, delegation: null,
  }
}

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
  // The demo host has read every session: it is never still indexing.
  backend.register('sessionRecordList', () => ({ records: store.listSessions().map(demoSessionRecord), indexing: false }))
  backend.register('sessionRecordSearch', (args) => {
    const query = arg<SessionRecordSearchQuery>(args, 0)
    const results = store.searchSessions({ query: query.query })
    const offset = query.offset ?? 0
    return {
      results: results.slice(offset, offset + (query.limit ?? results.length))
        .map(({ session, ...hit }) => ({ ...hit, record: demoSessionRecord(session), additionalMatches: [] })),
      total: results.length,
      indexing: false,
    }
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
  backend.register('describeSession', (args) => ({ lineage: null, meta: store.getSessionInfo(arg<string>(args, 0)) }))
  backend.register('getSessionInfos', (args) => arg<string[]>(args, 0).map((sessionId) => store.getSessionInfo(sessionId)))
  backend.register('pinnedSessionsList', () => store.listPinnedSessions())
  backend.register('togglePinnedSession', (args) => store.togglePinnedSession(arg<PinnedSession>(args, 0)))
}
