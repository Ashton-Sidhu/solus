/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { sanitizeCommandId } from '@solus/contracts/analytics-events'
import { track } from '@solus/workspace-ui/lib/analytics'

describe('analytics event catalog privacy', () => {
  test('sanitizes dynamic palette command details', () => {
    expect(sanitizeCommandId('settings')).toBe('settings')
    expect(sanitizeCommandId('branch:main')).toBe('branch')
    expect(sanitizeCommandId('worktree:/some/path')).toBe('worktree')
    expect(sanitizeCommandId('plan:abc:def')).toBe('plan')
  })
})

test('tracking is safe before analytics initialization', () => {
  expect(() => track('app_opened', {})).not.toThrow()
})
