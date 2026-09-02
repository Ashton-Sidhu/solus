import { describe, expect, test } from 'bun:test'
import { reviewSessionStatus } from '@solus/server/review/session-lifecycle'

describe('direct review session lifecycle', () => {
  test('stays running through background authoring and settles only at a terminal status', () => {
    expect(reviewSessionStatus('queued')).toBe('running')
    expect(reviewSessionStatus('generating')).toBe('running')
    expect(reviewSessionStatus('ready')).toBe('completed')
    expect(reviewSessionStatus('outdated')).toBe('completed')
    expect(reviewSessionStatus('failed')).toBe('completed')
    expect(reviewSessionStatus('cancelled')).toBe('completed')
  })
})
