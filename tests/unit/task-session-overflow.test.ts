import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const root = join(import.meta.dir, '../..')
const railSource = readFileSync(
  join(root, 'src/renderer/components/project-panel/TaskSection.svelte'),
  'utf8',
)
const taskPageSource = readFileSync(
  join(root, 'src/renderer/components/tasks/task-page/TaskSessionsList.svelte'),
  'utf8',
)

describe('task session overflow', () => {
  test('bounds the project rail session history', () => {
    // WHY: a task with many attempts must not take over the project rail and
    // push the linked section or its primary action out of reach.
    expect(railSource).toContain(
      'max-h-48 overflow-y-auto overscroll-contain [scrollbar-width:none]',
    )
  })

  test('bounds the task page session history', () => {
    // WHY: comments and linked work below Sessions must stay reachable without
    // scrolling through the complete attempt history first.
    expect(taskPageSource).toContain(
      'max-h-[min(22rem,42vh)] overflow-y-auto overscroll-contain',
    )
    expect(taskPageSource).toContain('[scrollbar-width:none]')
  })
})
