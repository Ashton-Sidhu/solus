// What the task page's move menu offers.
import type { Task, TaskMoveTarget, TaskSourceState } from '@solus/contracts/task-types'
import type { TaskStatusCategory } from '@solus/contracts/task-sources'
import { CATEGORY_META, TASK_CATEGORIES, taskPlacementLabels } from '../../lib/tasks-api'

export interface TaskMoveOption {
  id: string
  label: string
  /** Draws the option's glyph and colour. */
  category: TaskStatusCategory
  /** The task is here now. */
  current: boolean
  target: TaskMoveTarget
}

export interface TaskMoveGroup {
  id: string
  /** The source that owns the columns. Null for the status categories. */
  label: string | null
  options: TaskMoveOption[]
}

/**
 * The places a task can move to.
 *
 * A column belongs to one source, and the columns of two sources do not line
 * up. So each source that lists the task gets a group with its own columns, in
 * the provider's order. When no source of the task has columns that this
 * client knows (a task that only a session link brought here), the menu offers
 * the three status categories and the host chooses the column.
 */
export function taskMoveGroups(
  task: Pick<Task, 'category' | 'placements'>,
  sourceByKey: ReadonlyMap<string, Pick<TaskSourceState, 'label' | 'columns'>>,
): TaskMoveGroup[] {
  const groups = taskPlacementLabels(task, sourceByKey)
    .filter((placement) => placement.columns.length > 0)
    .map((placement): TaskMoveGroup => ({
      id: placement.sourceKey,
      label: placement.sourceLabel,
      options: placement.columns.map((column) => ({
        id: `${placement.sourceKey}:${column.id}`,
        label: column.name,
        category: column.category,
        current: column.id === placement.columnId,
        target: { sourceKey: placement.sourceKey, columnId: column.id },
      })),
    }))
  if (groups.length) return groups
  return [{
    id: 'categories',
    label: null,
    options: TASK_CATEGORIES.map((category) => ({
      id: category,
      label: CATEGORY_META[category].label,
      category,
      current: category === task.category,
      target: { category },
    })),
  }]
}
