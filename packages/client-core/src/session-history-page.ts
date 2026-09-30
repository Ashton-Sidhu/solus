import type { HostApi } from './host-api'
import type { SessionHistoryPage, SessionHistoryPageRequest } from '@solus/contracts/session-history'

/** User turns a restored or opened conversation reads first. Few enough that
 *  first paint does not depend on how long the session has run. */
export const INITIAL_HISTORY_TURNS = 10
/** User turns each scroll back to older history reads. */
export const OLDER_HISTORY_TURNS = 20

type HistoryApi = Pick<HostApi, 'loadSessionPage'>

interface PrefetchedHistory {
  key: string
  expiresAt: number
  result: Promise<SessionHistoryPage>
  page?: SessionHistoryPage
}

// One bounded startup read per connection. Consume once; never reuse it for a
// reconnect or a later visit to a session whose history may have changed.
const prefetchedHistory = new WeakMap<HistoryApi, PrefetchedHistory>()

function historyKey(request: SessionHistoryPageRequest): string {
  return JSON.stringify([request.sessionId, request.projectPath, request.provider,
    request.turnLimit, request.before])
}

export function prefetchSessionHistoryPage(api: HistoryApi, request: SessionHistoryPageRequest): Promise<SessionHistoryPage> {
  const key = historyKey(request)
  const existing = prefetchedHistory.get(api)
  if (existing?.key === key && existing.expiresAt > Date.now()) return existing.result
  const result = api.loadSessionPage(request)
  const entry: PrefetchedHistory = { key, expiresAt: Date.now() + 30_000, result }
  prefetchedHistory.set(api, entry)
  void result.then((page) => { entry.page = page }).catch(() => {
    if (prefetchedHistory.get(api) === entry) prefetchedHistory.delete(api)
  })
  return result
}

/** Use history in the first render if it arrived before mount. Otherwise normal
 * hydration consumes the pending request without delaying the workspace. */
export function readPrefetchedSessionHistoryPage(api: HistoryApi, request: SessionHistoryPageRequest): SessionHistoryPage | undefined {
  const entry = prefetchedHistory.get(api)
  return entry?.key === historyKey(request) && entry.expiresAt > Date.now() ? entry.page : undefined
}

/** Read a page, taking the startup read when it is for the same request. */
export async function requestSessionHistoryPage(api: HistoryApi, request: SessionHistoryPageRequest): Promise<SessionHistoryPage> {
  const prefetched = prefetchedHistory.get(api)
  prefetchedHistory.delete(api)
  return prefetched?.key === historyKey(request) && prefetched.expiresAt > Date.now()
    ? prefetched.result
    : api.loadSessionPage(request)
}
