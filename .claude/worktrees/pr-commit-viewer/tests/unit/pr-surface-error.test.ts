import { describe, expect, test } from 'bun:test'
import { prSurfaceError } from '../../src/renderer/components/prs/lib/pr-surface-error'

describe('PR surface errors', () => {
  test('maps the existing missing-credential error to the GitHub connect action', () => {
    // WHY: the provider already distinguishes a missing host credential. PR
    // surfaces must show the per-host connect action instead of generic retry.
    expect(prSurfaceError(new Error('GitHub is not connected'))).toEqual({
      kind: 'github-auth',
      message: 'GitHub is not connected',
    })
  })

  test('maps the existing reauthorization error to the GitHub connect action', () => {
    expect(prSurfaceError(new Error(
      'Your GitHub authorization is no longer valid. Reconnect GitHub to continue.',
    )).kind).toBe('github-auth')
  })

  test('keeps unrelated provider failures generic', () => {
    expect(prSurfaceError(new Error('GitHub request failed: 502'))).toEqual({
      kind: 'generic',
      message: 'GitHub request failed: 502',
    })
  })
})
