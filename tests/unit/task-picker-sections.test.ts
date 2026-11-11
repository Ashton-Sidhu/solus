import { describe, expect, test } from 'bun:test'
import type { TaskStatusCategory } from '@solus/contracts/task-sources'
import { taskPickerSections } from '@solus/workspace-ui/components/tasks/lib/task-picker-sections'

interface PickerTask {
  id: string
  category: TaskStatusCategory
}

function task(id: string, category: TaskStatusCategory): PickerTask {
  return { id, category }
}

describe('task picker sections', () => {
  test('groups tasks by status category: work in progress first, then open, then done', () => {
    // WHY: a picker mixes the tasks of every source, and the status category
    // is the one status they share. The task a session most likely joins is
    // one that is already active, so it must not sit below finished work.
    const sections = taskPickerSections([
      task('closed', 'done'),
      task('backlog', 'open'),
      task('in-review', 'active'),
      task('new', 'open'),
      task('in-progress', 'active'),
    ])

    expect(sections.map((section) => section.label)).toEqual(['Active', 'Open', 'Done'])
    expect(sections.map((section) => section.key)).toEqual(['active', 'open', 'done'])
    // The picker moves its selection by one flat index over all sections.
    expect(sections.map((section) => section.startIndex)).toEqual([0, 2, 4])
    expect(sections[1].tasks.map((item) => item.id)).toEqual(['backlog', 'new'])
  })

  test('omits empty sections and preserves order inside each section', () => {
    const sections = taskPickerSections([task('newer', 'active'), task('older', 'active')])

    expect(sections).toEqual([
      { key: 'active', label: 'Active', startIndex: 0, tasks: [task('newer', 'active'), task('older', 'active')] },
    ])
  })
})
