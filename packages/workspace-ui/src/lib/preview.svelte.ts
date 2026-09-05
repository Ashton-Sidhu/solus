import { serverConnections } from '@solus/client-core/server-connections'
import { MemoryCache } from '@solus/contracts/cache'
import type { IpcContext, SessionMeta } from '@solus/contracts/types'
import type { SessionMessageWindow, SessionPreviewResult } from '@solus/contracts/session-history'
import type { PickerEntry } from './sessionUtils'
import {
  extractPreviewMessages,
  type LoadedHitWindow,
  type PreviewExtraction,
} from './sessionPreviewMessages'
import type { HostApi } from '@solus/client-core/host-api'
import { stampSessionMeta } from '@solus/client-core/session-meta'

/** The slice of one host's RPC surface a preview needs. A history entry names
 *  the host that holds it, so a session on another machine previews from there
 *  rather than returning an empty body from this one. */
export interface PreviewHost {
  serverId: string
  loadSessionPreview: HostApi['loadSessionPreview']
  loadSessionMessageWindow: HostApi['loadSessionMessageWindow']
  getSessionInfo: HostApi['getSessionInfo']
}

interface PreviewLoaderDeps {
  hostFor(serverId: string): PreviewHost
}

/** A search hit to open the preview on: which host holds the session, and
 *  which indexed message the words were found in. */
export interface PreviewHitTarget {
  serverId: string
  sessionId: string
  messageId: number
}

/** Messages either side of a hit. One each way: the turn the words answer
 *  and the turn that answers them, without the pane becoming a transcript. */
const HIT_WINDOW_RADIUS = 1

/**
 * Owns the async loading of the session preview body shown beside the picker.
 * Title/byline/time-ago are pure derivations of the selected entry and live in
 * the component; this only manages the message body, which needs imperative
 * loading (debounce, cache, in-flight cancellation).
 *
 *  - Open entries render their live messages on the next frame.
 *  - History entries hit a cache, else debounce a backend fetch.
 *
 * A monotonic sequence guards every async path so a stale load can never apply
 * over a newer selection. `shouldApply()` is the caller's final check (still
 * selected, scope unchanged) evaluated after the fetch resolves.
 */
export class PreviewLoader {
  snapshot = $state<PreviewExtraction | null>(null)
  /** The passage a search hit sits in, when the preview was opened on one.
   *  Set instead of `snapshot`, never beside it. */
  hitWindow = $state<LoadedHitWindow | null>(null)
  hiddenCount = $state<number | undefined>(undefined)
  /** Everything in the transcript, shown or collapsed. The phone's peek names
   *  the size of the conversation it is showing two messages of. */
  messageCount = $state<number | undefined>(undefined)
  loading = $state(false)

  #cache = new MemoryCache<string, SessionPreviewResult>({ maxEntries: 100 })
  #hitCache = new MemoryCache<string, SessionMessageWindow>({ maxEntries: 100 })
  #seq = 0
  #debounce: ReturnType<typeof setTimeout> | null = null
  #frame: number | null = null

  constructor(private readonly deps: PreviewLoaderDeps) {}

  clearCache() {
    this.#cache.clear()
    this.#hitCache.clear()
  }

  /** Cancel any in-flight load and blank the body. */
  reset() {
    if (this.#debounce) {
      clearTimeout(this.#debounce)
      this.#debounce = null
    }
    if (this.#frame) {
      cancelAnimationFrame(this.#frame)
      this.#frame = null
    }
    this.#seq++
    this.snapshot = null
    this.hitWindow = null
    this.hiddenCount = undefined
    this.messageCount = undefined
    this.loading = false
  }

  #apply(result: SessionPreviewResult) {
    const snapshot = extractPreviewMessages([...result.head, ...result.tail])
    this.snapshot = snapshot
    this.hitWindow = null
    const shown = (snapshot.firstUserMessage ? 1 : 0) + (snapshot.lastAssistantMessage ? 1 : 0)
    this.hiddenCount = Math.max(0, result.totalMessages - shown)
    this.messageCount = result.totalMessages
  }

  /**
   * Open the preview on a search hit: the message the words were found in and
   * its neighbours, from the host's index. The index can have moved on since
   * the search that named the message; when it no longer has it, `fallback`
   * — the session's ordinary preview — is shown instead, so the pane is never
   * blank for a session that exists.
   */
  showHit(
    hit: PreviewHitTarget,
    fallback: PickerEntry | null,
    ctx: IpcContext,
    shouldApply: () => boolean,
  ) {
    if (this.#debounce) clearTimeout(this.#debounce)
    if (this.#frame) cancelAnimationFrame(this.#frame)

    const cacheKey = `${hit.serverId}:${hit.sessionId}:${hit.messageId}`
    const cached = this.#hitCache.get(cacheKey)
    if (cached) {
      this.#seq++
      this.loading = false
      this.#applyHit(cached, hit, fallback, ctx, shouldApply)
      return
    }

    const seq = ++this.#seq
    this.loading = true
    this.snapshot = null
    this.hitWindow = null
    this.hiddenCount = undefined
    this.messageCount = undefined
    this.#debounce = setTimeout(async () => {
      try {
        const host = this.deps.hostFor(hit.serverId)
        const window = await host.loadSessionMessageWindow({
          sessionId: hit.sessionId,
          messageId: hit.messageId,
          radius: HIT_WINDOW_RADIUS,
        })
        this.#hitCache.set(cacheKey, window)
        if (seq === this.#seq && shouldApply()) {
          this.loading = false
          this.#applyHit(window, hit, fallback, ctx, shouldApply)
        }
      } catch {
        if (seq === this.#seq) this.loading = false
      }
    }, 140)
  }

  #applyHit(
    window: SessionMessageWindow,
    hit: PreviewHitTarget,
    fallback: PickerEntry | null,
    ctx: IpcContext,
    shouldApply: () => boolean,
  ) {
    if (window.messages.length === 0) {
      if (fallback) this.show(fallback, ctx, shouldApply)
      return
    }
    this.snapshot = null
    this.hitWindow = { window, hitMessageId: hit.messageId }
    this.hiddenCount = undefined
    this.messageCount = window.messages.length + window.hiddenBefore + window.hiddenAfter
  }

  show(
    entry: PickerEntry,
    ctx: IpcContext,
    shouldApply: () => boolean,
    onMeta?: (meta: SessionMeta) => void,
  ) {
    if (this.#debounce) clearTimeout(this.#debounce)
    if (this.#frame) cancelAnimationFrame(this.#frame)

    if (entry.kind === 'open') {
      const seq = ++this.#seq
      this.loading = false
      const entrySession = entry.session
      this.#frame = requestAnimationFrame(() => {
        if (seq !== this.#seq) return
        this.#frame = null
        const snapshot = extractPreviewMessages(entrySession.messages)
        this.snapshot = snapshot
        this.hitWindow = null
        const shown =
          (snapshot.firstUserMessage ? 1 : 0) + (snapshot.lastAssistantMessage ? 1 : 0)
        this.hiddenCount = Math.max(0, entrySession.messages.length - shown)
        this.messageCount = entrySession.messages.length
      })
      return
    }

    // History entries are host-stamped where host data enters the client; an
    // entry that somehow lost its stamp has no host to preview from.
    const metaServerId = entry.meta.serverId
    if (!metaServerId) {
      this.#seq++
      this.loading = false
      this.snapshot = null
      this.hitWindow = null
      this.hiddenCount = undefined
      this.messageCount = undefined
      return
    }

    const cacheKey = `${metaServerId}:${entry.meta.provider}:${entry.meta.projectPath}:${entry.meta.sessionId}`
    const cached = this.#cache.get(cacheKey)
    if (cached) {
      this.#seq++
      this.loading = false
      this.#apply(cached)
      return
    }

    const seq = ++this.#seq
    this.loading = true
    this.snapshot = null
    this.hitWindow = null
    this.hiddenCount = undefined
    this.messageCount = undefined
    this.#debounce = setTimeout(async () => {
      try {
        // Refresh single-session metadata (e.g. a `/rename` since the cached
        // scan) alongside the preview body. `dir` is the real cwd, not the
        // encoded folder. Never let a metadata failure block the preview.
        const host = this.deps.hostFor(metaServerId)
        const [result, info] = await Promise.all([
          host.loadSessionPreview(
            entry.meta.sessionId,
            entry.meta.projectPath,
            ctx,
            entry.meta.provider,
          ),
          host.getSessionInfo(entry.meta.sessionId).catch(() => null),
        ])
        this.#cache.set(cacheKey, result)
        if (seq === this.#seq && shouldApply()) {
          this.#apply(result)
          this.loading = false
          if (info) onMeta?.(stampSessionMeta(info, host.serverId)!)
        }
      } catch {
        if (seq === this.#seq) this.loading = false
      }
    }, 140)
  }
}

export function createSessionPreviewStore(): PreviewLoader {
  return new PreviewLoader({
    hostFor: (serverId) => {
      const resolvedServerId = serverConnections.resolveId(serverId)
      const api = serverConnections.apiFor(resolvedServerId)
      return {
        serverId: resolvedServerId,
        loadSessionPreview: api.loadSessionPreview,
        loadSessionMessageWindow: api.loadSessionMessageWindow,
        getSessionInfo: api.getSessionInfo,
      }
    },
  })
}
