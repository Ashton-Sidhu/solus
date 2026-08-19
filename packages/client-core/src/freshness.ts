/**
 * The freshness ladder: what a client actually knows about one host's copy of
 * one domain (dispatch-client step 2). Every per-host domain reports a rung;
 * no spinner may claim more than the ladder knows.
 *
 * - `empty` — nothing known: no cache, no live data.
 * - `cached` — showing a persisted snapshot; the host has not answered in
 *   this connection session.
 * - `synchronizing` — a fetch is in flight; whatever renders is still the
 *   cache (or nothing).
 * - `live` — the host answered in this connection session; deltas apply.
 */
export type Freshness = 'empty' | 'cached' | 'synchronizing' | 'live'

/**
 * Error is an independent axis, never a rung: a healthy socket with a failed
 * sync shows "connected, sync error" while the cached rows keep rendering.
 * Clearing happens on the next successful sync, not on retry start.
 */
export interface DomainSyncState {
  freshness: Freshness
  error: string | null
}

export function emptySyncState(): DomainSyncState {
  return { freshness: 'empty', error: null }
}

/** Live data always wins: a snapshot may only seed rungs below `live`, so a
 *  reconnect can never let a stale cache overwrite newer live rows. */
export function mayApplyCachedSnapshot(state: DomainSyncState): boolean {
  return state.freshness === 'empty' || state.freshness === 'cached'
}
