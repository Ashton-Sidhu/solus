import { describe, expect, test } from 'bun:test'
import { shouldShowSidebarChild } from '@solus/workspace-ui/components/session/lib/task-list'

describe('sidebar child visibility', () => {
  test('removes a dismissed session row once its mounted tab closes', () => {
    expect(shouldShowSidebarChild(true, false)).toBe(false)
  })

  test('restores a dismissed child while its session is explicitly open', () => {
    // Dismissing a session row hides it only while the session is closed, so
    // reopening that session must bring the row back.
    expect(shouldShowSidebarChild(true, true)).toBe(true)
  })
})
