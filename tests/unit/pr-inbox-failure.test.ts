import { describe, expect, test } from 'bun:test'
import { prInboxFailure } from '@solus/workspace-ui/components/prs/lib/pr-inbox-failure'

const ok = { serverId: 'local', label: 'solus', error: null }
const noAuth = {
  serverId: 'local',
  label: 'solus',
  error: { kind: 'github-auth' as const, message: 'GitHub is not connected' },
}
const broken = {
  serverId: 'local',
  label: 'notes',
  error: { kind: 'generic' as const, message: 'GitHub request failed (503).' },
}
const noRemote = {
  serverId: 'local',
  label: 'My Workspace',
  error: {
    kind: 'no-repository' as const,
    message: 'This folder has no recognizable git remote to review PRs from.',
  },
}

describe('All-projects PR failures', () => {
  test('says nothing when every project loaded', () => {
    expect(prInboxFailure([ok, ok], true).kind).toBe('none')
  })

  // WHY: the inbox keeps a failed project's last-safe rows, so a failure that
  // is not stated reads as "that project has no pull requests". A project that
  // fails beside one that succeeds must still be announced.
  test('announces a partial failure over the rows that did load', () => {
    expect(prInboxFailure([ok, noAuth], true)).toEqual({
      kind: 'github-auth',
      placement: 'banner',
      serverId: 'local',
    })
  })

  // WHY: losing the GitHub connection is the one failure with a fix the person
  // can perform, so it outranks a project that failed for any other reason.
  test('offers the GitHub connection over a generic failure', () => {
    const failure = prInboxFailure([broken, noAuth], false)
    expect(failure.kind).toBe('github-auth')
    expect(failure.placement).toBe('page')
  })

  test('takes over the page when nothing loaded at all', () => {
    expect(prInboxFailure([broken], false)).toEqual({
      kind: 'generic',
      placement: 'page',
      summary: 'Couldn’t load pull requests from notes.',
      detail: 'GitHub request failed (503).',
    })
  })

  // WHY: My Workspace and any other folder without a remote have no pull
  // requests to fail at. Reporting them turns a normal workspace into a page
  // of errors the person cannot act on.
  test('says nothing about a project with no git remote', () => {
    expect(prInboxFailure([ok, noRemote], true).kind).toBe('none')
    expect(prInboxFailure([noRemote], false).kind).toBe('none')
  })

  // WHY: a real failure beside a remote-less project must still be announced,
  // and must not be counted as two.
  test('names only the project that really failed', () => {
    expect(prInboxFailure([noRemote, broken], true)).toMatchObject({
      kind: 'generic',
      summary: 'Couldn’t load pull requests from notes.',
    })
  })

  test('counts the projects rather than naming them all', () => {
    const failure = prInboxFailure([broken, { ...broken, label: 'docs' }], true)
    expect(failure).toMatchObject({ placement: 'banner', summary: 'Couldn’t load pull requests from 2 projects.' })
  })
})
