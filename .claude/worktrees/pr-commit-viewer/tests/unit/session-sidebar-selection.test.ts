import { describe, expect, test } from 'bun:test'
import { taskTabTarget } from '../../src/renderer/contexts/workspace/session-sidebar-selection'

describe('session sidebar task selection', () => {
  test('does not reuse another task\'s last-active tab on a shared branch', () => {
    expect(taskTabTarget(['task-b-tab'], null, 'task-a-tab')).toBe('task-b-tab')
  })

  test('reuses the last-active tab when it belongs to the selected task', () => {
    expect(
      taskTabTarget(
        ['task-b-first-tab', 'task-b-second-tab'],
        null,
        'task-b-second-tab',
      ),
    ).toBe('task-b-second-tab')
  })
})
