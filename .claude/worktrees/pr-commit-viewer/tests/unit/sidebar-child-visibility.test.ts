import { describe, expect, test } from 'bun:test'
import { shouldShowSidebarChild } from '../../src/renderer/components/session/lib/task-list'

describe('sidebar child visibility', () => {
  test('removes a dismissed subtask once its mounted tab closes', () => {
    expect(shouldShowSidebarChild(true, false)).toBe(false)
  })

  test('restores a dismissed child while its session is explicitly open', () => {
    // Completing a subtask dismisses its row the same way removing one does, so
    // reopening that session must bring the child back either way.
    expect(shouldShowSidebarChild(true, true)).toBe(true)
  })
})
