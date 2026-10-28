import type { SidebarTask } from './task-list'

/**
 * Which rows nest under another row, and under which one.
 *
 * A session that another session delegated sits under the row of the session
 * that started it, one step in, rather than as a row of its own. A chain of
 * delegations nests under its top row, so the tree is always one level deep. A
 * session whose parent has no row here keeps its own row: nesting must never
 * hide a session. Only an active row takes children, because the shelves draw
 * slim rows with no room for a tree under them. A cycle has no top, so nothing
 * in it nests.
 *
 * `parentSessionOf` maps a row id to the id of the session that delegated it;
 * `rowOfSession` maps a session id to the id of the row that shows it. Returns
 * each nested row id with the id of the row it sits under.
 */
export function nestedRowParents(
  rows: readonly Pick<SidebarTask, 'id' | 'lifecycle'>[],
  parentSessionOf: ReadonlyMap<string, string>,
  rowOfSession: ReadonlyMap<string, string>,
): Map<string, string> {
  const lifecycleOf = new Map(rows.map((row) => [row.id, row.lifecycle]))

  function topRowOf(rowId: string): string | null {
    const seen = new Set([rowId])
    let current = rowId
    for (;;) {
      const parentSessionId = parentSessionOf.get(current)
      const parentRowId = parentSessionId ? rowOfSession.get(parentSessionId) : undefined
      if (!parentRowId || !lifecycleOf.has(parentRowId) || parentRowId === current) return current
      if (seen.has(parentRowId)) return null
      seen.add(parentRowId)
      current = parentRowId
    }
  }

  const parents = new Map<string, string>()
  for (const rowId of parentSessionOf.keys()) {
    if (!lifecycleOf.has(rowId)) continue
    const top = topRowOf(rowId)
    if (top && top !== rowId && lifecycleOf.get(top) === 'active') parents.set(rowId, top)
  }
  return parents
}

/**
 * The delegated sessions a row lists. A collapsed row hides them, but never
 * the session on screen: collapsing must not hide the session being read.
 */
export function visibleNestedSessions<T extends { tabId?: string | null }>(
  nested: readonly T[],
  isCollapsed: boolean,
  onScreenTabId: string | null,
): T[] {
  if (!isCollapsed) return [...nested]
  return nested.filter((session) => !!session.tabId && session.tabId === onScreenTabId)
}
