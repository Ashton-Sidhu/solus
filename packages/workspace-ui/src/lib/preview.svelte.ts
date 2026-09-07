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

/** The two ends of a transcript, and how long it is. */
interface TranscriptEnds {
  snapshot: PreviewExtraction
  totalMessages: number
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
 *  - A search hit loads its window and the transcript's ends together, so the
 *    pane can show the opening, the passage, and the last reply in order.
 *
 * A monotonic sequence guards every async path so a stale load can never apply
 * over a newer selection. `shouldApply()` is the caller's final check (still
 * selected, scope unchanged) evaluated after the fetch resolves.
 */
export class PreviewLoader {
  snapshot = $state<PreviewExtraction | null>(null)
  /** The passage a search hit sits in, when the preview was opened on one.
   *  Set beside `snapshot` when the ends were read, alone when they were not. */
  hitWindow = $state<LoadedHitWindow | null>(null)
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
    this.#cancelPending()
    this.#seq++
    this.#blank()
    this.loading = false
  }

  #cancelPending() {
    if (this.#debounce) {
      clearTimeout(this.#debounce)
      this.#debounce = null
    }
    if (this.#frame) {
      cancelAnimationFrame(this.#frame)
      this.#frame = null
    }
  }

  #blank() {
    this.snapshot = null
    this.hitWindow = null
    this.messageCount = undefined
  }

  #applyEnds(ends: TranscriptEnds) {
    this.snapshot = ends.snapshot
    this.messageCount = ends.totalMessages
  }

  #apply(result: SessionPreviewResult) {
    this.#applyEnds(endsOf(result))
    this.hitWindow = null
  }

  #historyCacheKey(entry: Extract<PickerEntry, { kind: 'history' }>, serverId: string): string {
    return `${serverId}:${entry.meta.provider}:${entry.meta.projectPath}:${entry.meta.sessionId}`
  }

  /** The transcript's ends without asking a host: a live tab's messages, or a
   *  durable session already read this visit. Null when a read is needed. */
  #cachedEnds(entry: PickerEntry): TranscriptEnds | null {
    if (entry.kind === 'open') {
      return {
        snapshot: extractPreviewMessages(entry.session.messages),
        totalMessages: entry.session.messages.length,
      }
    }
    const serverId = entry.meta.serverId
    if (!serverId) return null
    const cached = this.#cache.get(this.#historyCacheKey(entry, serverId))
    return cached ? endsOf(cached) : null
  }

  /** The transcript's ends from the host that holds them. Null for an entry
   *  with no host to ask. */
  async #loadEnds(entry: PickerEntry, ctx: IpcContext): Promise<TranscriptEnds | null> {
    const cached = this.#cachedEnds(entry)
    if (cached) return cached
    if (entry.kind !== 'history' || !entry.meta.serverId) return null
    const host = this.deps.hostFor(entry.meta.serverId)
    const result = await host.loadSessionPreview(
      entry.meta.sessionId,
      entry.meta.projectPath,
      ctx,
      entry.meta.provider,
    )
    this.#cache.set(this.#historyCacheKey(entry, entry.meta.serverId), result)
    return endsOf(result)
  }

  /**
   * Open the preview on a search hit: the message the words were found in and
   * its neighbours, from the host's index, beside the transcript's ends from
   * `source` — the session's ordinary preview — so the pane reads opening,
   * match, last reply. The index can have moved on since the search that named
   * the message; when it no longer has it, the ends alone are shown, so the
   * pane is never blank for a session that exists.
   */
  showHit(
    hit: PreviewHitTarget,
    source: PickerEntry | null,
    ctx: IpcContext,
    shouldApply: () => boolean,
  ) {
    this.#cancelPending()

    const windowKey = `${hit.serverId}:${hit.sessionId}:${hit.messageId}`
    const cachedWindow = this.#hitCache.get(windowKey)
    const cachedEnds = source ? this.#cachedEnds(source) : null
    if (cachedWindow && (cachedEnds || !source)) {
      this.#seq++
      this.loading = false
      this.#applyHit(cachedWindow, hit, cachedEnds)
      return
    }

    const seq = ++this.#seq
    this.loading = true
    this.#blank()
    this.#debounce = setTimeout(async () => {
      try {
        const host = this.deps.hostFor(hit.serverId)
        const [window, ends] = await Promise.all([
          cachedWindow
            ?? host.loadSessionMessageWindow({
              sessionId: hit.sessionId,
              messageId: hit.messageId,
              radius: HIT_WINDOW_RADIUS,
            }).then((loaded) => {
              this.#hitCache.set(windowKey, loaded)
              return loaded
            }),
          // A host that cannot give the ends still leaves the window to show.
          source ? this.#loadEnds(source, ctx).catch(() => null) : Promise.resolve(null),
        ])
        if (seq === this.#seq && shouldApply()) {
          this.loading = false
          this.#applyHit(window, hit, ends)
        }
      } catch {
        if (seq === this.#seq) this.loading = false
      }
    }, 140)
  }

  #applyHit(window: SessionMessageWindow, hit: PreviewHitTarget, ends: TranscriptEnds | null) {
    if (ends) this.#applyEnds(ends)
    else {
      this.snapshot = null
      this.messageCount = window.messages.length + window.hiddenBefore + window.hiddenAfter
    }
    this.hitWindow = window.messages.length ? { window, hitMessageId: hit.messageId } : null
  }

  show(
    entry: PickerEntry,
    ctx: IpcContext,
    shouldApply: () => boolean,
    onMeta?: (meta: SessionMeta) => void,
  ) {
    this.#cancelPending()

    if (entry.kind === 'open') {
      const seq = ++this.#seq
      this.loading = false
      this.#frame = requestAnimationFrame(() => {
        if (seq !== this.#seq) return
        this.#frame = null
        this.#applyEnds(this.#cachedEnds(entry)!)
        this.hitWindow = null
      })
      return
    }

    // History entries are host-stamped where host data enters the client; an
    // entry that somehow lost its stamp has no host to preview from.
    const metaServerId = entry.meta.serverId
    if (!metaServerId) {
      this.#seq++
      this.loading = false
      this.#blank()
      return
    }

    const cached = this.#cache.get(this.#historyCacheKey(entry, metaServerId))
    if (cached) {
      this.#seq++
      this.loading = false
      this.#apply(cached)
      return
    }

    const seq = ++this.#seq
    this.loading = true
    this.#blank()
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
        this.#cache.set(this.#historyCacheKey(entry, metaServerId), result)
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

function endsOf(result: SessionPreviewResult): TranscriptEnds {
  return {
    snapshot: extractPreviewMessages([...result.head, ...result.tail]),
    totalMessages: result.totalMessages,
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
