/**
 * The task page's four sections, named once.
 *
 * A wide pane scrolls all four past each other in one column, which is the
 * right shape when there is room: the reader sees the body, then what it is
 * linked to, then what has run, then what was said, without deciding to.
 *
 * A stacked pane cannot do that — the composer at the foot would be pushed off
 * screen by whichever section happened to be long — so the same four sections
 * become a tab strip and the composer stays pinned. Same sections, same order,
 * same counts; only one of them is on screen at a time.
 *
 * The counts are the point of the strip. A tab is worth opening when it holds
 * something, and a reader who cannot see the sections needs the numbers to
 * decide which one to open.
 */

export type TaskTabId = 'overview' | 'linked' | 'sessions' | 'activity'

export interface TaskTabSpec {
  id: TaskTabId
  label: string
  /** Absent on Overview, which is the body itself rather than a collection of
   *  things — a "1" beside it would be counting the task. */
  count?: number
}

/** What each section holds right now, in the order the desktop column has them. */
export interface TaskTabCounts {
  /** Linked docs, plans, automations and pull requests. */
  linked: number
  /** Agent runs started for this task. */
  sessions: number
  /** Comments plus lifecycle events. */
  activity: number
}

export function taskTabs(counts: TaskTabCounts): TaskTabSpec[] {
  return [
    { id: 'overview', label: 'Overview' },
    { id: 'linked', label: 'Linked', count: counts.linked },
    { id: 'sessions', label: 'Sessions', count: counts.sessions },
    { id: 'activity', label: 'Activity', count: counts.activity },
  ]
}
