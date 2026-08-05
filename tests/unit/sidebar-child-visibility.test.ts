import { describe, expect, test } from 'bun:test'
import { shouldShowSidebarChild } from '../../src/renderer/components/session/lib/task-list'

describe('sidebar child visibility', () => {
  test('removes a dismissed subtask once its mounted tab closes', () => {
    expect(shouldShowSidebarChild(true, false)).toBe(false)
  })

  test('restores a dismissed child while its session is explicitly open', () => {
    expect(shouldShowSidebarChild(true, true)).toBe(true)
  })

  test('keeps a completed child dismissed while its session continues running', () => {
    // Task completion and session execution are independent lifecycles.
    expect(shouldShowSidebarChild(true, true, true)).toBe(false)
  })
})
