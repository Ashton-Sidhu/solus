import type { TaskStatusCategory } from '@solus/contracts/task-sources'
import { CATEGORY_META } from './tasks-api'

interface TaskWithCategory {
  category: TaskStatusCategory
}

export interface TaskPickerSection<T extends TaskWithCategory> {
  key: string
  label: string
  startIndex: number
  tasks: T[]
}

/** A picker shows the work in progress first, then what is open, then what is done. */
const PICKER_CATEGORY_ORDER: TaskStatusCategory[] = ['active', 'open', 'done']

/** Group picker results by status category, with the names the Tasks page shows. */
export function taskPickerSections<T extends TaskWithCategory>(
  tasks: readonly T[],
): TaskPickerSection<T>[] {
  const sections: TaskPickerSection<T>[] = []
  let startIndex = 0

  for (const category of PICKER_CATEGORY_ORDER) {
    const groupedTasks = tasks.filter((task) => task.category === category)
    if (groupedTasks.length === 0) continue
    sections.push({
      key: category,
      label: CATEGORY_META[category].label,
      startIndex,
      tasks: groupedTasks,
    })
    startIndex += groupedTasks.length
  }

  return sections
}
