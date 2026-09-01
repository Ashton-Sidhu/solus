import { describe, expect, test } from 'bun:test'
import { taskTitleRegenerationInput } from '@solus/workspace-ui/contexts/tasks/task-title-regeneration'

describe('task title regeneration', () => {
  test('uses the durable description instead of feeding an old generated name back to the model', () => {
    // WHY: regeneration must be able to produce a materially different name;
    // the task description is the source of truth when it exists.
    expect(taskTitleRegenerationInput({
      title: 'Old Generated Name',
      body: '  Add title regeneration to the task context menu.  ',
    })).toBe('Add title regeneration to the task context menu.')
  })

  test('falls back to the current name when the task has no description', () => {
    expect(taskTitleRegenerationInput({ title: 'Inbox capture', body: '   ' }))
      .toBe('Inbox capture')
  })
})
