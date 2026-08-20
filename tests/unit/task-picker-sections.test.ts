import { describe, expect, test } from 'bun:test'
import type { TaskStatus } from '@solus/contracts/task-types'
import { taskPickerSections } from '@solus/workspace-ui/components/tasks/lib/task-picker-sections'

interface PickerTask {
  id: string
  status: TaskStatus
}

function task(id: string, status: TaskStatus): PickerTask {
  return { id, status }
}

describe('task picker status sections', () => {
  test('groups tasks in lifecycle order and keeps inbox work under Todo', () => {
    // WHY: picker users should scan by the same lifecycle names and order as
    // the Tasks page instead of searching one flat list of unrelated work.
    const sections = taskPickerSections([
      task('done', 'done'),
      task('todo', 'todo'),
      task('review', 'in_review'),
      task('inbox', 'inbox'),
      task('active', 'in_progress'),
      task('dropped', 'dropped'),
    ])

    expect(sections.map((section) => section.label)).toEqual([
      'In progress',
      'In review',
      'Todo',
      'Done',
      'Closed',
    ])
    expect(sections.map((section) => section.startIndex)).toEqual([0, 1, 2, 4, 5])
    expect(sections.find((section) => section.key === 'todo')?.tasks.map((item) => item.id)).toEqual([
      'todo',
      'inbox',
    ])
  })

  test('omits empty status sections and preserves order inside each section', () => {
    const sections = taskPickerSections([
      task('newer', 'in_progress'),
      task('older', 'in_progress'),
    ])

    expect(sections).toEqual([
      {
        key: 'in_progress',
        label: 'In progress',
        startIndex: 0,
        tasks: [task('newer', 'in_progress'), task('older', 'in_progress')],
      },
    ])
  })
})
