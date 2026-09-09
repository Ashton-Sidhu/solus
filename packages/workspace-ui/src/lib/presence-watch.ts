import { SvelteMap } from 'svelte/reactivity'

const UPSTREAM_POLL_MS = 5 * 60_000

export interface UpstreamCheckTiming {
  lastCheckedAt: number | null
  nextCheckAt: number
  checking: boolean
}

interface Watch {
  key: string
  timer: ReturnType<typeof setInterval>
  watchers: number
  refresh: () => void | Promise<void>
  pending: Promise<void> | null
}

/** Reference-counted polling for data used by mounted document surfaces. */
export class PresenceWatch {
  private watches = new Map<string, Watch>()
  readonly timings = new SvelteMap<string, UpstreamCheckTiming>()

  watch(key: string, refresh: () => void | Promise<void>): () => void {
    const existing = this.watches.get(key)
    if (existing) {
      existing.watchers += 1
      this.refresh(existing)
      return () => this.release(key)
    }

    const watch: Watch = {
      key,
      timer: setInterval(() => {
        const timing = this.timings.get(key)
        if (timing) this.timings.set(key, { ...timing, nextCheckAt: Date.now() + UPSTREAM_POLL_MS })
        this.refresh(watch)
      }, UPSTREAM_POLL_MS),
      watchers: 1,
      refresh,
      pending: null,
    }
    this.watches.set(key, watch)
    this.timings.set(key, { lastCheckedAt: null, nextCheckAt: Date.now() + UPSTREAM_POLL_MS, checking: true })
    if (this.watches.size === 1) {
      globalThis.window?.addEventListener('focus', this.refreshMounted)
      globalThis.document?.addEventListener('visibilitychange', this.handleVisibility)
    }
    this.refresh(watch)
    return () => this.release(key)
  }

  private refresh(watch: Watch): void {
    if (watch.pending) return
    // Defer the callback so it cannot add reactive dependencies to the effect
    // that registers a header, and coalesce focus, visibility and pane mounts.
    watch.pending = Promise.resolve().then(() => {
      const timing = this.timings.get(watch.key)
      if (timing) this.timings.set(watch.key, { ...timing, checking: true })
      return watch.refresh()
    }).catch(() => {
      // Stores report provider failures in their domain state. A rejected
      // request must still release the next check.
    }).finally(() => {
      watch.pending = null
      if (this.watches.get(watch.key) !== watch) return
      const timing = this.timings.get(watch.key)
      if (timing) this.timings.set(watch.key, { ...timing, lastCheckedAt: Date.now(), checking: false })
    })
  }

  private refreshMounted = (): void => {
    for (const watch of this.watches.values()) this.refresh(watch)
  }

  private handleVisibility = (): void => {
    if (document.visibilityState === 'visible') this.refreshMounted()
  }

  private release(key: string): void {
    const watch = this.watches.get(key)
    if (!watch) return
    watch.watchers -= 1
    if (watch.watchers > 0) return
    clearInterval(watch.timer)
    this.watches.delete(key)
    this.timings.delete(key)
    if (this.watches.size === 0) {
      globalThis.window?.removeEventListener('focus', this.refreshMounted)
      globalThis.document?.removeEventListener('visibilitychange', this.handleVisibility)
    }
  }
}
