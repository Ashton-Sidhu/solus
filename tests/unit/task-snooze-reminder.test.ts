import { describe, expect, test } from 'bun:test'
import { resolveTaskSnoozeReminder } from '../../src/renderer/contexts/tasks/task-snooze'

describe('task snooze reminder', () => {
  test('shows a generic conversation reminder when the optional note is empty', () => {
    // WHY: ending a snooze must create visible conversation content even when
    // the user chose a wake time without writing a reminder note.
    expect(resolveTaskSnoozeReminder({ snoozedUntil: 999 }, 1_000)).toEqual({
      detail: 'Ready to continue',
      wokeAt: 999,
    })
  })

  test('does not show the reminder before the wake time', () => {
    expect(resolveTaskSnoozeReminder({ snoozedUntil: 1_001 }, 1_000)).toBeNull()
  })

  test('uses the saved reminder note after the wake time', () => {
    expect(resolveTaskSnoozeReminder({
      snoozedUntil: 999,
      snoozeNote: '  Check the canary  ',
    }, 1_000)).toEqual({
      detail: 'Check the canary',
      wokeAt: 999,
    })
  })
})
