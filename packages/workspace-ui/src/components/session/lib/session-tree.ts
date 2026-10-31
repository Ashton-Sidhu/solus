import { hasGlyph, taskStatusFor, type TaskStatus } from './task-list'
import type { SidebarTask } from './task-list'
import type { AttentionState } from '../../../lib/sessionUtils'

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
 * The rows of every session that a session delegated, at any depth. A settle
 * or an archive of a row applies to these rows too: when the parent is
 * finished, its delegated sessions must not stay in the list as rows of their
 * own. `sessionOf` gives the session a row shows, with the session that
 * delegated it. A cycle ends the walk.
 */
export function delegatedRows<T>(
  rootSessionId: string,
  rows: readonly T[],
  sessionOf: (row: T) => { id: string; parentSessionId?: string | null } | null,
): T[] {
  const parentIds = new Set([rootSessionId])
  const candidates = rows.flatMap((row) => {
    const session = sessionOf(row)
    return session?.parentSessionId ? [{ row, id: session.id, parentSessionId: session.parentSessionId }] : []
  })
  const found: T[] = []
  let hasGrown = true
  while (hasGrown) {
    hasGrown = false
    for (let i = 0; i < candidates.length;) {
      const candidate = candidates[i]
      if (!parentIds.has(candidate.parentSessionId)) {
        i++
        continue
      }
      candidates.splice(i, 1)
      if (parentIds.has(candidate.id)) continue
      parentIds.add(candidate.id)
      found.push(candidate.row)
      hasGrown = true
    }
  }
  return found
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

/** One mark of a session under a row, as the row's trailing slot stacks them. */
export type NestedStateMark =
  | { kind: 'glyph'; status: TaskStatus }
  | { kind: 'unread' }
  | { kind: 'spinner' }

/** The order the stack reads in: what wants the person first, then unread
 *  output, then work in flight. */
const GLYPH_ORDER: TaskStatus[] = ['error', 'question', 'plan', 'limit']

/**
 * What the sessions under a row are doing, as one stack of marks: each
 * distinct state once, in the order the sidebar ranks them. The row's own
 * mark takes the slot when it has one; this stack stands in only when the
 * row itself is quiet, so a folded drawer never hides a session that wants
 * the person or is still working.
 */
export function nestedStateMarks(
  sessions: readonly Pick<{ attention: AttentionState; unread: boolean }, 'attention' | 'unread'>[],
): NestedStateMark[] {
  const glyphs = new Set<TaskStatus>()
  let unread = false
  let running = false
  for (const session of sessions) {
    const status = taskStatusFor(session.attention)
    if (hasGlyph(status)) glyphs.add(status)
    if (session.unread) unread = true
    if (status === 'running') running = true
  }
  const marks: NestedStateMark[] = GLYPH_ORDER.filter((status) => glyphs.has(status)).map((status) => ({ kind: 'glyph', status }))
  if (unread) marks.push({ kind: 'unread' })
  if (running) marks.push({ kind: 'spinner' })
  return marks
}
