import type { TaskSourceState } from '@solus/contracts/task-types'
import type { TaskInvolvement } from '@solus/contracts/task-inspection'
import type { TaskViewFilters } from '@solus/contracts/task-views'

export interface TaskListSelection {
  sourceKey: string | null
  query: string
  involvement: TaskInvolvement
  status: 'open' | 'active' | 'done' | 'all'
}
/** The native list keeps the same saved filters as the workspace list and board. */
export function mobileTaskFilters(
  selection: TaskListSelection,
  sources: TaskSourceState[],
  applied: TaskViewFilters | null
): TaskViewFilters {
  const defaults: TaskViewFilters = {
    sourceKey: null,
    query: '',
    layout: 'list',
    sort: 'updated',
    involvement: 'all',
    runningOnly: false,
    overdueOnly: false,
    assignedOnly: false,
    snoozedOnly: false,
    columnIds: null
  }
  const filters = {
    ...(applied ?? defaults),
    sourceKey: selection.sourceKey,
    query: selection.query,
    involvement: selection.involvement
  }
  if (applied || selection.status === 'all') return filters
  if (!selection.sourceKey) {
    filters.columnIds = [selection.status]
    return filters
  }
  filters.columnIds =
    sources
      .find((source) => source.sourceKey === selection.sourceKey)
      ?.columns.filter((column) => column.category === selection.status)
      .map((column) => column.id) ?? []
  return filters
}
