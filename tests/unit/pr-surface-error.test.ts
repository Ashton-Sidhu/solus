import { describe, expect, test } from 'bun:test'
import { prSurfaceError, prUnavailableTitle } from '@solus/workspace-ui/components/prs/lib/pr-surface-error'

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

  test('names the project and tells a plain folder from a repository with no remote', () => {
    // WHY: the page scope is shared by every project page, so the project may
    // have been picked elsewhere. "This project has no git remote" about an
    // unnamed plain folder read as a false claim about the repository in view.
    expect(prUnavailableTitle('not-a-repository', 'projects')).toBe('projects is not a git repository.')
    expect(prUnavailableTitle('no-remote', 'notes')).toBe('notes has no git remote.')
  })
})
