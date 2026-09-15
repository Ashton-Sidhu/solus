import { describe, expect, test } from 'bun:test'
import type { PrChecksSummary } from '@solus/contracts/checks-types'
import { checksPresentation } from '@solus/workspace-ui/components/prs/lib/checks'

const summary: PrChecksSummary = {
  state: 'pending',
  required: [],
  optional: [],
  headSha: 'current-head',
  inFlight: true,
}

describe('checks status labels', () => {
  test('distinguishes the first lookup from checks running on the current head', () => {
    expect(checksPresentation(undefined, 'current-head', false).label).toBe('Checking')
    expect(checksPresentation(summary, 'current-head', false).label).toBe('Running')
  })

  test('does not report old checks as running or passing after a push', () => {
    for (const state of ['pending', 'passing'] as const) {
      expect(checksPresentation({ ...summary, state }, 'new-head', false)).toMatchObject({
        label: 'Checking',
        stale: true,
      })
    }
  })

  test('lookup failure ends checking and does not assert a cached result', () => {
    for (const cached of [undefined, summary]) {
      expect(checksPresentation(cached, 'current-head', true)).toMatchObject({
        state: 'unavailable',
        label: 'Checks unavailable',
      })
    }
  })

  test('settled checks retain their result labels', () => {
    for (const [state, label] of [['passing', 'Passing'], ['failing', 'Failing'], ['none', 'No checks']] as const) {
      expect(checksPresentation({ ...summary, state, inFlight: false }, 'current-head', false).label).toBe(label)
    }
  })
})
