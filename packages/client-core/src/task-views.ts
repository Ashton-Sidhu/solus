import type { TaskSummary } from '@solus/contracts/task-types'
import type { TaskViewFilters } from '@solus/contracts/task-views'

function matchesPlacement(task: TaskSummary, filters: TaskViewFilters): boolean {
  if (!filters.sourceKey) return !filters.columnIds || filters.columnIds.includes(task.category)
  const placement = task.placements.find((place) => place.sourceKey === filters.sourceKey)
  if (!placement) return false
  return !filters.columnIds || filters.columnIds.includes(placement.columnId ?? '')
}

function matchesTaskState(
  task: TaskSummary,
  filters: TaskViewFilters,
  now: number,
  runningTaskIds: ReadonlySet<string>
): boolean {
  if (filters.runningOnly && !runningTaskIds.has(task.id)) return false
  if (
    filters.overdueOnly &&
    (!task.dueDate || task.category === 'done' || Date.parse(`${task.dueDate}T23:59:59`) >= now)
  )
    return false
  if (filters.assignedOnly && !task.assignee && !task.assignees?.length) return false
  return (task.snoozedUntil !== undefined && task.snoozedUntil > now) === filters.snoozedOnly
}

function matchesQuery(task: TaskSummary, query: string): boolean {
  return `${task.title} ${task.reference ?? ''} ${task.labels.join(' ')} ${task.assignees?.map((person) => person.login).join(' ') ?? task.assignee ?? ''}`
    .toLowerCase()
    .includes(query)
}

/** Saved filters have the same meaning on every client. Board layout is a presentation choice. */
export function tasksForSavedView<T extends TaskSummary>(
  tasks: readonly T[],
  filters: TaskViewFilters,
  now: number,
  runningTaskIds: ReadonlySet<string>,
  providerSearched = false
): T[] {
  const priorities = { urgent: 0, high: 1, medium: 2, low: 3 }
  const due = (task: T) =>
    task.dueDate ? Date.parse(`${task.dueDate}T00:00:00`) : Number.POSITIVE_INFINITY
  const priority = (task: T) => (task.priority ? priorities[task.priority] : 4)
  const query = filters.query.trim().toLowerCase()
  return tasks
    .filter(
      (task) =>
        matchesPlacement(task, filters) &&
        matchesTaskState(task, filters, now, runningTaskIds) &&
        (providerSearched || !query || matchesQuery(task, query))
    )
    .sort((a, b) => {
      const updated = b.updatedAt - a.updatedAt
      if (filters.sort === 'priority')
        return priority(a) - priority(b) || due(a) - due(b) || updated
      if (filters.sort === 'due') return due(a) - due(b) || priority(a) - priority(b) || updated
      if (filters.sort === 'created')
        return (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt)
      return updated
    })
}
