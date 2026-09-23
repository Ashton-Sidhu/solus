import type { HostApi } from './host-api'
import type { IpcContext } from '@solus/contracts/types'
import type { SessionHistoryPage, SessionHistoryPageRequest, WireSessionLoadMessage } from '@solus/contracts/session-history'

export const RESTORED_TRANSCRIPT_LIMIT = 200

type HistoryApi = Pick<HostApi, 'loadSessionPage' | 'loadSession'>

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
    request.limit, request.before, !!request.deferToolInputs])
}

export function prefetchSessionHistoryPage(api: HistoryApi, request: SessionHistoryPageRequest): Promise<SessionHistoryPage> | undefined {
  if (!api.loadSessionPage) return undefined
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

/** An older remote host can still open a transcript. Never fall back after a
 * cursor was issued, or turn a failed/unauthorized read into a different read. */
export async function requestSessionHistoryPage(
  api: HistoryApi,
  request: SessionHistoryPageRequest,
  ctx: IpcContext,
): Promise<SessionHistoryPage | WireSessionLoadMessage[]> {
  if (api.loadSessionPage) {
    try {
      const prefetched = prefetchedHistory.get(api)
      prefetchedHistory.delete(api)
      return await (prefetched?.key === historyKey(request) && prefetched.expiresAt > Date.now()
        ? prefetched.result
        : api.loadSessionPage(request))
    } catch (error) {
      const unsupported = error instanceof Error &&
        (error.message.includes('Unknown method "loadSessionPage"') || error.message.includes('no handler for "loadSessionPage"'))
      if (request.before || !unsupported) throw error
    }
  }
  if (request.before) throw new Error('This host no longer supports history pages. Reopen the session.')
  return api.loadSession(request.sessionId, request.projectPath, ctx, request.provider, request.limit,
    request.deferToolInputs ? { deferToolInputs: true } : undefined)
}
