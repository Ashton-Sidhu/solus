import { describe, expect, test } from 'bun:test'
import {
  isRepositoryKey,
  localProjectKey,
  parseRemoteUrls,
  primaryRemoteUrl,
  repositoryKeyFromRemoteUrl,
} from '@solus/contracts/repository-key'

describe('repository key', () => {
  test('every remote spelling of one repository gives one key', () => {
    // WHY: a laptop cloned over SSH and a Linux box cloned over HTTPS hold the
    // same project. Different keys would split its tasks and sessions in two.
    const spellings = [
      'git@github.com:Acme/Web.git',
      'https://github.com/acme/web.git',
      'https://github.com/acme/web/',
      'ssh://git@github.com/acme/web',
      'git://github.com/acme/web.git',
    ]
    expect(new Set(spellings.map(repositoryKeyFromRemoteUrl))).toEqual(new Set(['github.com/acme/web']))
  })

  test('keeps the whole path, so two GitLab subgroups stay two projects', () => {
    expect(repositoryKeyFromRemoteUrl('git@gitlab.com:group/one/app.git')).toBe('gitlab.com/group/one/app')
    expect(repositoryKeyFromRemoteUrl('git@gitlab.com:group/two/app.git')).toBe('gitlab.com/group/two/app')
  })

  test('a remote that names no hosted repository gives no key', () => {
    expect(repositoryKeyFromRemoteUrl('/srv/git/web.git')).toBeNull()
    expect(repositoryKeyFromRemoteUrl('https://example.com/')).toBeNull()
    expect(repositoryKeyFromRemoteUrl('')).toBeNull()
  })

  test('a fork is named by its upstream, then origin, then the first remote', () => {
    // WHY: a fork and its upstream are one project; the push remote is where
    // this checkout sends branches, not what the project is.
    const fork = new Map([['origin', 'git@github.com:me/web.git'], ['upstream', 'git@github.com:acme/web.git']])
    expect(primaryRemoteUrl(fork)).toBe('git@github.com:acme/web.git')
    expect(primaryRemoteUrl(new Map([['zeta', 'z'], ['origin', 'o']]))).toBe('o')
    expect(primaryRemoteUrl(new Map([['zeta', 'z'], ['alpha', 'a']]))).toBe('a')
    expect(primaryRemoteUrl(new Map())).toBeNull()
  })

  test('reads remote URLs from git config', () => {
    // WHY: Solus clones dispatch and managed-host checkouts with a filter, and
    // `git remote -v` prints it after `(fetch)`. Parsing that text made such a
    // checkout a local-only project, listed twice beside its own repository.
    // Config output has one fixed shape, and push URLs are a separate key.
    const output = [
      'remote.origin.url https://github.com/me/web.git',
      'remote.my.fork.url git@github.com:me/web-fork.git',
      'remote.upstream.url https://github.com/acme/web.git',
    ].join('\n')
    expect(parseRemoteUrls(output)).toEqual(new Map([
      ['origin', 'https://github.com/me/web.git'],
      ['my.fork', 'git@github.com:me/web-fork.git'],
      ['upstream', 'https://github.com/acme/web.git'],
    ]))
  })

  test('tells a repository key from a path and from a local-only key', () => {
    expect(isRepositoryKey('github.com/acme/web')).toBe(true)
    expect(isRepositoryKey('/Users/me/web')).toBe(false)
    expect(isRepositoryKey(localProjectKey('host-a', '/Users/me/scratch'))).toBe(false)
  })
})
