/** A hidden conversation keeps its DOM and effects only while it is one of
 *  the few the reader moves between. Past that, it unmounts; its view state
 *  (`ConversationViewState`) brings back what they left open and where. */
export const MAX_MOUNTED_CONVERSATIONS = 4

/**
 * The tabs whose conversation stays mounted, most recent first: the active
 * one, then the most recently shown, up to `limit`. A closed tab drops out.
 * An inactive pool — the web shell that is not on screen — mounts nothing, so
 * two shells never hold the same conversation.
 */
export function mountedConversationTabIds(
  recentTabIds: readonly string[],
  activeTabId: string | null,
  openTabIds: readonly string[],
  poolActive: boolean,
  limit = MAX_MOUNTED_CONVERSATIONS,
): string[] {
  if (!poolActive) return []
  const open = new Set(openTabIds)
  const mounted: string[] = []
  for (const tabId of activeTabId ? [activeTabId, ...recentTabIds] : recentTabIds) {
    if (mounted.length >= limit) break
    if (open.has(tabId) && !mounted.includes(tabId)) mounted.push(tabId)
  }
  return mounted
}
