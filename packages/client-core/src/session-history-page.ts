import type { WatchSessionResult } from '@solus/contracts/types'
import type { HostApi } from './host-api'
import type { SessionHistoryPage, SessionHistoryPageRequest } from '@solus/contracts/session-history'

/** User turns a restored or opened conversation reads first. Few enough that
 *  first paint does not depend on how long the session has run. */
export const INITIAL_HISTORY_TURNS = 10
/** User turns each scroll back to older history reads. */
export const OLDER_HISTORY_TURNS = 20
/** Screens of loaded history still above the reader when the next older page
 *  starts to load. A page then arrives before the reader reaches the top, and
 *  their scroll does not stop there to wait for it. */
export const HISTORY_PREFETCH_SCREENS = 3

type HistoryApi = Pick<HostApi, 'loadSessionPage'>

type CachedHistory = () => Promise<SessionHistoryPage | null>

function sameHistoryManifest(left: SessionHistoryPage, right: SessionHistoryPage): boolean {
  const before = left.historyBlocks
  const after = right.historyBlocks
  if (!before || !after || before.length !== after.length || left.before !== right.before) return false
  if (left.turnDiffs !== right.turnDiffs && JSON.stringify(left.turnDiffs) !== JSON.stringify(right.turnDiffs)) return false
  return before.every((block, index) => block.hash === after[index]?.hash && block.count === after[index]?.count)
}

/** The host confirmed the same rows, older boundary and turn diffs. */
export function sameHistoryPage(left: SessionHistoryPage, right: SessionHistoryPage): boolean {
  return left === right || (left.messages.length === right.messages.length && sameHistoryManifest(left, right))
}

interface HistoryResumeOptions {
  cachedTurnLimit?(page: SessionHistoryPage): number
  onResumedWatch?(watch: WatchSessionResult): void
}

export async function loadSessionHistoryPage(
  api: HistoryApi, request: SessionHistoryPageRequest, readCache?: CachedHistory, cacheWaitMs = 0,
  options?: HistoryResumeOptions,
): Promise<SessionHistoryPage> {
  if (!readCache) return api.loadSessionPage(request)
  // Bound how long block negotiation can delay the network. A saved page can
  // still paint independently if the disk misses the deadline.
  let deadline: ReturnType<typeof setTimeout> | undefined
  const cached = await Promise.race([
    readCache().catch(() => null),
    new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), cacheWaitMs) }),
  ])
  clearTimeout(deadline)
  const offsets = new Map<string, { start: number; count: number }>()
  let savedRows = 0
  for (const block of cached?.historyBlocks ?? []) {
    offsets.set(block.hash, { start: savedRows, count: block.count })
    savedRows += block.count
  }
  if (savedRows !== cached?.messages.length) offsets.clear()
  const window = cached && options?.cachedTurnLimit ? { ...request, turnLimit: options.cachedTurnLimit(cached) } : request
  const watchRevision = options?.onResumedWatch && savedRows === cached?.messages.length && offsets.size <= 128
    ? cached?.historyRevision : undefined
  const { resumedWatch, ...page } = await api.loadSessionPage({
    ...window, knownHistoryBlocks: [...offsets.keys()].slice(0, 128),
    ...(watchRevision && { watchIfHistoryRevision: watchRevision }),
  })
  if (resumedWatch && watchRevision && watchRevision === page.historyRevision) options?.onResumedWatch?.(resumedWatch)
  if (cached && savedRows === cached.messages.length && !page.messages.length &&
      page.historyBlocks?.every(block => block.reused) && sameHistoryManifest(cached, page)) {
    return page.historyRevision && page.historyRevision !== cached.historyRevision ? { ...cached, historyRevision: page.historyRevision } : cached
  }
  return restoreHistoryBlocks(page, cached, offsets) ?? api.loadSessionPage(window)
}

/** A missing or invalid block means the host must send the complete page. */
function restoreHistoryBlocks(
  page: SessionHistoryPage,
  cached: SessionHistoryPage | null,
  offsets: ReadonlyMap<string, { start: number; count: number }>,
): SessionHistoryPage | null {
  if (!page.historyBlocks?.some(block => block.reused)) return page
  const messages: SessionHistoryPage['messages'] = []
  let offset = 0
  for (const block of page.historyBlocks) {
    const saved = block.reused ? offsets.get(block.hash) : undefined
    if (block.reused && (!cached || !saved || saved.count !== block.count)) return null
    const source = saved && cached ? cached.messages : page.messages
    const start = saved?.start ?? offset
    if (start + block.count > source.length) return null
    for (let index = start; index < start + block.count; index++) messages.push(source[index]!)
    if (!block.reused) offset += block.count
  }
  if (offset !== page.messages.length) return null
  return { ...page, messages, historyBlocks: page.historyBlocks.map(({ hash, count }) => ({ hash, count })) }
}

interface PrefetchedHistory {
  key: string
  expiresAt: number
  /** False once the session moved on from what the page shows: the read is then not used. */
  isCurrent?: () => boolean
  result: Promise<SessionHistoryPage>
  page?: SessionHistoryPage
}

// One bounded early read per connection: the startup tab's, or the session the
// reader just clicked. Consume once; never reuse it for a reconnect or a later
// visit to a session whose history may have changed.
const prefetchedHistory = new WeakMap<HistoryApi, PrefetchedHistory>()

function historyKey(request: SessionHistoryPageRequest, scope: string | undefined): string {
  return JSON.stringify([scope, request.sessionId, request.projectPath, request.provider,
    request.turnLimit, request.before, request.throughEntryId, !!request.deferArtifactHtml, !!request.replyLayout, !!request.promptFiles, !!request.turnItems])
}

function servesRequest(entry: PrefetchedHistory | undefined, key: string): entry is PrefetchedHistory {
  return entry?.key === key && entry.expiresAt > Date.now() && (entry.isCurrent?.() ?? true)
}

/** `maxAgeMs`: how long the page may serve an open. A read the reader may
 *  never open lives shorter, so an open does not show an old page.
 *  `isCurrent`: whether the page still shows the session as it is. A page read
 *  while a run works stays whole only while that run goes on, because the
 *  watch at the open replays that run; another run makes the page stale. */
export function prefetchSessionHistoryPage(api: HistoryApi, request: SessionHistoryPageRequest, maxAgeMs = 30_000, scope?: string, readCache?: CachedHistory, isCurrent?: () => boolean): Promise<SessionHistoryPage> {
  const key = historyKey(request, scope)
  const existing = prefetchedHistory.get(api)
  if (servesRequest(existing, key)) return existing.result
  const result = loadSessionHistoryPage(api, request, readCache)
  const entry: PrefetchedHistory = { key, expiresAt: Date.now() + maxAgeMs, isCurrent, result }
  prefetchedHistory.set(api, entry)
  void result.then((page) => { entry.page = page }).catch(() => {
    if (prefetchedHistory.get(api) === entry) prefetchedHistory.delete(api)
  })
  return result
}

/** Use history in the first render if it arrived before mount. Otherwise normal
 * hydration consumes the pending request without delaying the workspace. */
export function readPrefetchedSessionHistoryPage(api: HistoryApi, request: SessionHistoryPageRequest, scope?: string): SessionHistoryPage | undefined {
  const entry = prefetchedHistory.get(api)
  return servesRequest(entry, historyKey(request, scope)) ? entry.page : undefined
}

/** Read a page, taking the startup read when it is for the same request. */
export async function requestSessionHistoryPage(api: HistoryApi, request: SessionHistoryPageRequest, scope?: string, readCache?: CachedHistory): Promise<SessionHistoryPage> {
  const prefetched = prefetchedHistory.get(api)
  prefetchedHistory.delete(api)
  return servesRequest(prefetched, historyKey(request, scope))
    ? prefetched.result
    : loadSessionHistoryPage(api, request, readCache)
}
