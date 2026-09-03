import { describe, expect, test } from 'bun:test'
import { prActivityLoadFailureMessage } from '@solus/workspace-ui/components/pr-review/lib/activity-load-failure'

describe('PR activity load failure message', () => {
  test('names the section that failed', () => {
    expect(prActivityLoadFailureMessage(['changed-files'], false)).toBe(
      'Couldn’t load changed files. Check your connection or provider sign-in.',
    )
  })

  test('combines independent provider failures', () => {
    expect(prActivityLoadFailureMessage(['commits', 'comments'], true)).toBe(
      'Couldn’t load commits, comments, and review threads. Check your connection or provider sign-in.',
    )
  })

  test('returns no banner message when all sections loaded', () => {
    expect(prActivityLoadFailureMessage([], false)).toBeNull()
  })
})
