/**
 * Manual card order on the kanban board ("Tasks page" spec, board layout).
 *
 * The list sorts itself — by updated, priority or due date — and the board
 * inherits that sort until you touch a card. Dragging one is a statement the
 * sort can't make ("this is what I'm doing next"), so from the first drag the
 * cards you placed lead their column.
 *
 * Order is stored as a rank per task rather than a list per column, which is
 * what keeps this file two lines long: there is no saved list to reconcile
 * against the tasks actually on screen, so nothing here has to skip stale ids,
 * merge placed cards with unplaced ones, or translate a filtered index into a
 * saved one. A card either has a number or it doesn't.
 */
import type { Task } from '../../../../shared/task-types'

/** Task id → its slot in whatever column it currently sits in. */
export type BoardRanks = Record<string, number>

// Unplaced cards sort last. A finite sentinel rather than Infinity, because
// `Infinity - Infinity` is NaN — which `sort` does coerce to a tie, but by way
// of a spec footnote no reader should have to know.
const UNRANKED = Number.MAX_SAFE_INTEGER

/**
 * Order one column's cards.
 *
 * `sort` is stable (guaranteed since ES2019), so every card you have never
 * dragged ties at `UNRANKED` and keeps the page's own sort. That is the whole
 * reason placed and unplaced cards need no separate handling.
 */
export function orderColumn(tasks: Task[], ranks: BoardRanks): Task[] {
  const rankOf = (task: Task) => ranks[task.id] ?? UNRANKED
  return [...tasks].sort((a, b) => rankOf(a) - rankOf(b))
}
