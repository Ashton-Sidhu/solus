import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const read = (p: string) => readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/components/tasks/', p), 'utf8')
const tasksPage = read('TasksPage.svelte')
const composer = read('TaskComposer.svelte')

describe('New task hand-off', () => {
  test('the plain New task flow opens the created task page', () => {
    // WHY: creating from the list is a hand-off — the user's next move is the
    // task they just wrote, so the page follows the create instead of dropping
    // them back on the list to hunt for the new row.
    expect(tasksPage).toContain('createdForNavigation = inline ? null : created.id')
    expect(tasksPage).toContain('session.goToTask(createdForNavigation, "click")')
  })

  test('the inline flows stay on the list', () => {
    // WHY: adding into a board column or under an epic header is rapid entry in
    // place. Navigating away from it would lose the column or epic the user is
    // filling.
    expect(tasksPage).toContain('const inline = !!composing.parentId || !!composing.status')
  })

  test('"Create more" suppresses the hand-off', () => {
    // WHY: the hand-off fires only on the dismissal path, so a composer kept
    // open for the next task is never navigated out from under the user.
    expect(composer).toContain('if (createAnother) {\n      resetForAnother();\n      return;\n    }')
    expect(composer).toContain('onCreated?.()')
  })
})
