import { MemoryCache } from '../../shared/cache'
import type { IpcContext, Message, SessionMeta } from '../../shared/types'
import type {
  SessionLoadMessage,
  SessionPreviewResult,
} from '../../shared/claude-types'
import type { PickerEntry } from './sessionUtils'

interface PreviewLoaderDeps {
  loadSessionPreview: Window['solus']['loadSessionPreview']
  getSessionInfo: Window['solus']['getSessionInfo']
}

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
  messages = $state<Array<SessionLoadMessage | Message> | null>(null)
  hiddenCount = $state<number | undefined>(undefined)
  loading = $state(false)

  #cache = new MemoryCache<string, SessionPreviewResult>({ maxEntries: 100 })
  #seq = 0
  #debounce: ReturnType<typeof setTimeout> | null = null
  #frame: number | null = null

  constructor(private readonly deps: PreviewLoaderDeps) {}

  clearCache() {
    this.#cache.clear()
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
    this.messages = null
    this.hiddenCount = undefined
    this.loading = false
  }

  #apply(result: SessionPreviewResult) {
    this.messages = [...result.head, ...result.tail]
    this.hiddenCount = Math.max(
      0,
      result.totalMessages - result.head.length - result.tail.length,
    )
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
      this.hiddenCount = undefined
      const entrySession = entry.session
      this.#frame = requestAnimationFrame(() => {
        if (seq !== this.#seq) return
        this.#frame = null
        this.messages = entrySession.messages
      })
      return
    }

    const cacheKey = `${entry.meta.provider}:${entry.meta.projectPath}:${entry.meta.sessionId}`
    const cached = this.#cache.get(cacheKey)
    if (cached) {
      this.#seq++
      this.loading = false
      this.#apply(cached)
      return
    }

    const seq = ++this.#seq
    this.loading = true
    this.messages = null
    this.hiddenCount = undefined
    this.#debounce = setTimeout(async () => {
      try {
        // Refresh single-session metadata (e.g. a `/rename` since the cached
        // scan) alongside the preview body. `dir` is the real cwd, not the
        // encoded folder. Never let a metadata failure block the preview.
        const [result, info] = await Promise.all([
          this.deps.loadSessionPreview(
            entry.meta.sessionId,
            entry.meta.projectPath,
            ctx,
            entry.meta.provider,
          ),
          this.deps
            .getSessionInfo(entry.meta.sessionId, entry.meta.cwd, ctx, entry.meta.provider)
            .catch(() => null),
        ])
        this.#cache.set(cacheKey, result)
        if (seq === this.#seq && shouldApply()) {
          this.#apply(result)
          this.loading = false
          if (info) onMeta?.(info)
        }
      } catch {
        if (seq === this.#seq) this.loading = false
      }
    }, 140)
  }
}
