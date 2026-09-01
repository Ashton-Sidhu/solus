/**
 * When a page last finished loading, for the head's fused refresh chip.
 *
 * Stamped on the edge *out* of a load rather than on mount: a page that has
 * only ever mounted has not synced anything, and a chip reading "synced just
 * now" off a mount time is a lying label. Until the first load completes the
 * chip stays the bare verb.
 *
 * Pages whose store already records a provider fetch time (Tasks reads
 * `upstreamRefreshedAtByProject`) use that instead — it is the real answer, and
 * it survives a remount.
 */
export interface SyncStamp {
  /** When the last load finished, or `null` until one has. */
  readonly at: number | null
}

export function syncStamp(isLoading: () => boolean): SyncStamp {
  let at = $state<number | null>(null)
  // Edge detection, which `$derived` cannot express: the value depends on the
  // previous read, not only on the current one.
  let wasLoading = false
  $effect(() => {
    const loading = isLoading()
    if (wasLoading && !loading) at = Date.now()
    wasLoading = loading
  })
  return {
    get at() {
      return at
    },
  }
}
