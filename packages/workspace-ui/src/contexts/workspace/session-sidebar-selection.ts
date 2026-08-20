export function taskTabTarget(
  taskTabIds: string[],
  attentionTarget: string | null,
  lastActiveBranchTabId: string | null,
  runningTabId: string | null = null,
): string | undefined {
  if (attentionTarget) return attentionTarget
  if (lastActiveBranchTabId && taskTabIds.includes(lastActiveBranchTabId)) {
    return lastActiveBranchTabId
  }
  // Nothing is asking for the user and they have not been in this branch yet.
  // A session working right now is more relevant than the oldest tab, so prefer
  // it over the plain first-tab fallback (e.g. one done + one running lands on
  // the running one, not the done one just because it opened first).
  if (runningTabId && taskTabIds.includes(runningTabId)) return runningTabId
  return taskTabIds[0]
}

/** Pick the nearest still-open sidebar conversation after the selected one is
 * removed. The left neighbour wins a tie, which matches the tab strip's close
 * behavior. Shelved conversations can remain in `sidebarTabIds`, but only ids
 * in `openTabIds` are eligible navigation targets. */
export function closestOpenSidebarTabAfterClose(
  sidebarTabIds: string[],
  openTabIds: string[],
  closingTabIds: string[],
  activeTabId: string,
): string | null {
  const eligible = new Set(openTabIds.filter((tabId) => !closingTabIds.includes(tabId)))
  if (!eligible.size) return null

  const activeIndex = sidebarTabIds.indexOf(activeTabId)
  if (activeIndex === -1) return openTabIds.find((tabId) => eligible.has(tabId)) ?? null

  for (let distance = 1; distance < sidebarTabIds.length; distance++) {
    const left = sidebarTabIds[activeIndex - distance]
    if (left && eligible.has(left)) return left
    const right = sidebarTabIds[activeIndex + distance]
    if (right && eligible.has(right)) return right
  }
  return null
}
