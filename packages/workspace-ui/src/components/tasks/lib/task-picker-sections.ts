import type { TaskStatus } from '@solus/contracts/task-types'
import { TASK_STATUS_GROUPS } from './tasks-list-view'

interface TaskWithStatus {
  status: TaskStatus
}

export interface TaskPickerSection<T extends TaskWithStatus> {
  key: string
  label: string
  startIndex: number
  tasks: T[]
}

/** Group picker results by the lifecycle names users see on the Tasks page. */
export function taskPickerSections<T extends TaskWithStatus>(
  tasks: readonly T[],
): TaskPickerSection<T>[] {
  const sections: TaskPickerSection<T>[] = []
  let startIndex = 0

  for (const group of TASK_STATUS_GROUPS) {
    const groupedTasks = tasks.filter((task) => group.statuses.includes(task.status))
    if (groupedTasks.length === 0) continue
    sections.push({
      key: group.key,
      label: group.label,
      startIndex,
      tasks: groupedTasks,
    })
    startIndex += groupedTasks.length
  }

  return sections
}
