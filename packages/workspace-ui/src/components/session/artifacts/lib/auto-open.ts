import type { SessionArtifactsChange } from '../../../../contexts/sessions/session-artifacts.store.svelte'

/**
 * Whether a read of the conversation on screen opens its Artifacts surface:
 * only when a later read finds more artifacts than the one before. The first
 * read (`previous` null) is a load, not news, and a fall is never news.
 */
export function shouldOpenArtifacts(previous: number | null, next: number): boolean {
  return previous !== null && next > previous
}

/** How long after a change its newest row still draws attention when it mounts. */
export const HIGHLIGHT_WINDOW_MS = 4000

/** The row to highlight once: the newest one a recent rise added. */
export function highlightedArtifactKey(change: SessionArtifactsChange | null, now: number): string | null {
  if (!change?.newestKey || change.previousCount === null || change.count <= change.previousCount) return null
  return now - change.seenAt <= HIGHLIGHT_WINDOW_MS ? change.newestKey : null
}
