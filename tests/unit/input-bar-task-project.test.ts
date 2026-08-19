import { describe, expect, test } from 'bun:test'
import { shouldResetTaskForProjectChange } from '@solus/workspace-ui/components/input/lib/task-project-scope'

describe('input bar task project scope', () => {
  test('resets the task when the same composer changes folders', () => {
    // WHY: task choices belong to one project. Keeping the old choice after a
    // folder change can file the next session under a task from another project.
    expect(
      shouldResetTaskForProjectChange(
        { sourceId: 'draft-1', workingDirectory: '/projects/first' },
        { sourceId: 'draft-1', workingDirectory: '/projects/second' },
      ),
    ).toBe(true)
  })

  test('does not reset when the header starts following another composer', () => {
    // WHY: the unpinned header follows the active tab. A tab switch must show
    // that composer's saved task instead of replacing it with a new task.
    expect(
      shouldResetTaskForProjectChange(
        { sourceId: 'tab-1', workingDirectory: '/projects/first' },
        { sourceId: 'tab-2', workingDirectory: '/projects/second' },
      ),
    ).toBe(false)
  })
})
