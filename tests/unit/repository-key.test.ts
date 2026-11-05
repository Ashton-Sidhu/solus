import { describe, expect, test } from 'bun:test'
import {
  PullRequestHead,
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
      'github.com:Acme/Web.git',
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

  // WHY: git reads `host:path` as SSH and takes the user from ssh config, so
  // this is a working remote that must reach its code host.
  test('a remote that leaves its user to ssh config names its host', () => {
    expect(repositoryKeyFromRemoteUrl('gitlab.com:group/one/app.git')).toBe('gitlab.com/group/one/app')
  })

  test.each([
    'C:/repos/project',
    'C:\\repos\\project',
    '/srv/git/repo.git',
    './team:group/repo',
    '..\\team:group/repo',
    'file:///srv/git/repo.git',
    'hg::team/repo',
    'codecommit::us-east-1://repo',
  ])('%s is not read as a host', (remote) => {
    expect(repositoryKeyFromRemoteUrl(remote)).toBeNull()
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

describe('pull request head', () => {
  const pr = (owner: string, headRef: string) => ({ baseRepo: { host: 'github.com' }, headRepo: { owner, repo: 'litellm' }, headRef })

  test("a branch of the same name in another fork is not the head", () => {
    // WHY: GitHub matches a branch name in every fork. A session on `main` in
    // a fork must not claim the pull request a stranger opened from their `main`.
    const head = new PullRequestHead({ host: 'github.com', owner: 'Me', repo: 'LiteLLM' }, 'main')
    expect(head.isHeadOf(pr('stranger', 'main'))).toBe(false)
    expect(head.isHeadOf(pr('BerriAI', 'main'))).toBe(false)
    expect(head.isHeadOf(pr('me', 'main'))).toBe(true)
  })

  test('the branch name is exact, and the key tells heads apart', () => {
    // WHY: Git branch names are case-sensitive; repository names on GitHub are not.
    const head = new PullRequestHead({ host: 'github.com', owner: 'me', repo: 'litellm' }, 'Fix')
    expect(head.isHeadOf(pr('me', 'fix'))).toBe(false)
    expect(PullRequestHead.of(pr('ME', 'Fix')).key).toBe(head.key)
  })
})
