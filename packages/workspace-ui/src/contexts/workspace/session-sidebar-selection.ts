/** The first item after `currentId` that `isEligible` accepts, reading
 * downward and wrapping to the top. Finishing work moves the queue forward, so
 * the row below comes before the row above. An item absent from the list
 * starts the search at the top. */
function nextAfterWrapping<T>(
  items: readonly T[],
  current: T,
  isEligible: (item: T) => boolean,
): T | null {
  const index = items.indexOf(current)
  const ordered = index === -1 ? items : [...items.slice(index + 1), ...items.slice(0, index)]
  return ordered.find(isEligible) ?? null
}

/** Pick the next still-open sidebar conversation after the selected one is
 * removed. Shelved conversations can remain in `sidebarTabIds`, but only ids
 * in `openTabIds` are eligible navigation targets. */
export function nextOpenSidebarTabAfterClose(
  sidebarTabIds: string[],
  openTabIds: string[],
  closingTabIds: string[],
  activeTabId: string,
): string | null {
  const eligible = new Set(openTabIds.filter((tabId) => !closingTabIds.includes(tabId)))
  if (!eligible.size) return null
  const orderedTabIds = sidebarTabIds.includes(activeTabId) ? sidebarTabIds : openTabIds
  return nextAfterWrapping(orderedTabIds, activeTabId, (tabId) => eligible.has(tabId))
}

/** Pick the task row to show after `currentTaskId` leaves the active list —
 * snoozed, or completed with others. Rows in `leavingTaskIds` go with it. */
export function nextTaskAfterLeaving<T extends { id: string }>(
  tasks: readonly T[],
  currentTaskId: string,
  leavingTaskIds: ReadonlySet<string>,
): T | null {
  const current = tasks.find((task) => task.id === currentTaskId)
  if (!current) return null
  return nextAfterWrapping(tasks, current, (task) =>
    task.id !== currentTaskId && !leavingTaskIds.has(task.id),
  )
}
