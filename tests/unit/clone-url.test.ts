import { describe, expect, test } from 'bun:test'
import {
  classifyCloneInput,
  cloneUrlForIntent,
  cloneUrlForProtocol,
  matchesRepoQuery,
} from '@solus/workspace-ui/components/servers/lib/clone-url'

describe('new project omnibox classification', () => {
  test('an empty box lists what the host already has rather than demanding a URL', () => {
    expect(classifyCloneInput('   ')).toEqual({ kind: 'empty' })
  })

  test('a typed path stays a search instead of promising an open action the omnibox cannot perform', () => {
    // WHY: folders are opened through the browser action. Classifying a typed
    // path specially produced no row and dead-ended on "Nothing matches".
    expect(classifyCloneInput('~/dev/solus')).toEqual({ kind: 'search', query: '~/dev/solus' })
    expect(classifyCloneInput('/srv/checkouts')).toEqual({ kind: 'search', query: '/srv/checkouts' })
    expect(classifyCloneInput('../sibling')).toEqual({ kind: 'search', query: '../sibling' })
  })

  test('owner/repo resolves without a lookup round-trip', () => {
    expect(classifyCloneInput('solus-sh/solus')).toEqual({
      kind: 'owner-repo',
      owner: 'solus-sh',
      repo: 'solus',
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      repoName: 'solus',
    })
  })

  test('https URLs are accepted with or without the .git a browser drops', () => {
    expect(classifyCloneInput('https://github.com/solus-sh/solus.git')).toEqual({
      kind: 'clone-url',
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      repoName: 'solus',
      protocol: 'https',
    })
    expect(classifyCloneInput('https://github.com/solus-sh/solus')).toEqual({
      kind: 'clone-url',
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      repoName: 'solus',
      protocol: 'https',
    })
  })

  test('ssh and scp-like forms keep their protocol', () => {
    expect(classifyCloneInput('ssh://git@github.com/solus-sh/solus.git')).toMatchObject({
      kind: 'clone-url',
      protocol: 'ssh',
      repoName: 'solus',
    })
    expect(classifyCloneInput('git@github.com:solus-sh/solus.git')).toEqual({
      kind: 'clone-url',
      cloneUrl: 'git@github.com:solus-sh/solus.git',
      repoName: 'solus',
      protocol: 'ssh',
    })
  })

  test('anything else filters the repo list instead of erroring at the user', () => {
    expect(classifyCloneInput('solus')).toEqual({ kind: 'search', query: 'solus' })
    expect(classifyCloneInput('!!! nonsense ???')).toEqual({ kind: 'search', query: '!!! nonsense ???' })
    expect(classifyCloneInput('http://github.com/solus-sh/solus')).toEqual({
      kind: 'search',
      query: 'http://github.com/solus-sh/solus',
    })
  })
})

describe('protocol toggle', () => {
  test('changes the URL that would actually run, not just a label', () => {
    expect(cloneUrlForProtocol('https://github.com/solus-sh/solus.git', 'ssh'))
      .toBe('git@github.com:solus-sh/solus.git')
    expect(cloneUrlForProtocol('git@github.com:solus-sh/solus.git', 'https'))
      .toBe('https://github.com/solus-sh/solus.git')
  })

  test('a path or free text has nothing to clone', () => {
    expect(cloneUrlForIntent(classifyCloneInput('~/dev'), 'https')).toBeNull()
    expect(cloneUrlForIntent(classifyCloneInput('solus'), 'https')).toBeNull()
    expect(cloneUrlForIntent(classifyCloneInput('solus-sh/solus'), 'ssh'))
      .toBe('git@github.com:solus-sh/solus.git')
  })
})

describe('repository filtering', () => {
  test('matches on a subsequence so partial memory still finds the repo', () => {
    expect(matchesRepoQuery('solus-sh/solus', 'solsh')).toBe(true)
    expect(matchesRepoQuery('solus-sh/solus', 'zzz')).toBe(false)
    expect(matchesRepoQuery('solus-sh/solus', '')).toBe(true)
  })
})
