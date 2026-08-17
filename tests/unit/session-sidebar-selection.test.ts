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

  test('prefers a running session over the oldest tab when nothing needs the user', () => {
    // One done session (first in the list) and one running session: clicking the
    // task lands on the running one, not the done one just because it opened first.
    expect(
      taskTabTarget(['done-tab', 'running-tab'], null, null, 'running-tab'),
    ).toBe('running-tab')
  })

  test('a session needing attention still wins over a running one', () => {
    expect(
      taskTabTarget(['done-tab', 'running-tab'], 'done-tab', null, 'running-tab'),
    ).toBe('done-tab')
  })

  test('the last-active tab still wins over a running one', () => {
    expect(
      taskTabTarget(['done-tab', 'running-tab'], null, 'done-tab', 'running-tab'),
    ).toBe('done-tab')
  })
})
