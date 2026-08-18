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
const rendererStyles = readFileSync(join(root, 'src/renderer/index.css'), 'utf8')

describe('task session overflow', () => {
  test('reveals the standard scrollbar thumb on bounded-list hover', () => {
    // WHY: these short histories are not full-pane scrollers. Showing their
    // normal hairline thumb on hover makes the overflow discoverable while
    // retaining the shared scrolling and direct-thumb hover behavior.
    expect(rendererStyles).toContain('.scrollbar-on-hover:hover::-webkit-scrollbar-thumb')
    expect(rendererStyles).toContain('background: var(--solus-scroll-thumb);')
    expect(rendererStyles).toContain('.scrollbar-on-hover:hover::-webkit-scrollbar-thumb:hover')
    expect(rendererStyles).toContain('background: var(--solus-scroll-thumb-hover);')
  })

  test('bounds the project rail session history', () => {
    // WHY: a task with many attempts must not take over the project rail and
    // push the linked section or its primary action out of reach.
    expect(railSource).toContain(
      'scrollbar-on-hover max-h-48 overflow-y-auto overscroll-contain',
    )
    expect(railSource).not.toContain('[scrollbar-width:none]')
  })

  test('bounds the task page session history', () => {
    // WHY: comments and linked work below Sessions must stay reachable without
    // scrolling through the complete attempt history first.
    expect(taskPageSource).toContain(
      'scrollbar-on-hover max-h-[min(22rem,42vh)] overflow-y-auto overscroll-contain',
    )
    expect(taskPageSource).not.toContain('[scrollbar-width:none]')
  })
})
