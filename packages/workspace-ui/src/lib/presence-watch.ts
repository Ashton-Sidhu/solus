const UPSTREAM_POLL_MS = 5 * 60_000

/** Reference-counted polling for data that should refresh only while visible. */
export class PresenceWatch {
  private watches = new Map<string, { timer: ReturnType<typeof setInterval>; watchers: number }>()

  watch(key: string, refresh: () => void | Promise<void>): () => void {
    const existing = this.watches.get(key)
    if (existing) {
      existing.watchers += 1
      return () => this.release(key)
    }

    void refresh()
    const timer = setInterval(() => void refresh(), UPSTREAM_POLL_MS)
    this.watches.set(key, { timer, watchers: 1 })
    return () => this.release(key)
  }

  private release(key: string): void {
    const watch = this.watches.get(key)
    if (!watch) return
    watch.watchers -= 1
    if (watch.watchers > 0) return
    clearInterval(watch.timer)
    this.watches.delete(key)
  }
}
