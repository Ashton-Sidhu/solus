import { afterAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { resolvePrimaryRepoRef, resolveRepositoryKey } = await import('@solus/server/git/git-helpers')

const roots: string[] = []

function repoWithRemotes(remotes: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'solus-repository-key-'))
  roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const [name, url] of Object.entries(remotes)) execFileSync('git', ['remote', 'add', name, url], { cwd: root })
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('resolveRepositoryKey', () => {
  test('names a fork checkout by its upstream', async () => {
    // WHY: the fork on a laptop and the upstream clone on the managed host are
    // one project; naming them by origin would list the fork as a second one.
    const root = repoWithRemotes({ origin: 'git@github.com:me/web.git', upstream: 'https://github.com/Acme/web.git' })
    expect(await resolveRepositoryKey(root)).toBe('github.com/acme/web')
  })

  test('a folder with no hosted remote has no repository key', async () => {
    expect(await resolveRepositoryKey(repoWithRemotes({}))).toBeNull()
  })

  test('names a partial clone by its remote', async () => {
    // WHY: Solus clones dispatch and managed-host checkouts with a filter. A
    // filtered clone read as a local-only folder listed the project twice.
    const root = repoWithRemotes({ origin: 'https://github.com/acme/web.git' })
    execFileSync('git', ['config', 'remote.origin.promisor', 'true'], { cwd: root })
    execFileSync('git', ['config', 'remote.origin.partialclonefilter', 'blob:none'], { cwd: root })
    expect(await resolveRepositoryKey(root)).toBe('github.com/acme/web')
  })

  test('a folder that gains a remote is read again', async () => {
    // WHY: a clone in progress has no remote yet; caching that answer would
    // leave the finished checkout a local-only project until a restart.
    const root = repoWithRemotes({})
    expect(await resolveRepositoryKey(root)).toBeNull()
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: root })
    expect(await resolveRepositoryKey(root)).toBe('github.com/acme/web')
  })
})

describe('resolvePrimaryRepoRef', () => {
  test('reads pull requests from the repository the project key names', async () => {
    // WHY: the catalog names a fork by its upstream. Reading pull requests from
    // origin alone listed a fork's project with the fork's pull requests, and
    // a checkout with only an upstream remote as having none.
    const root = repoWithRemotes({ origin: 'git@github.com:me/web.git', upstream: 'https://github.com/Acme/web.git' })
    expect(await resolvePrimaryRepoRef(root)).toEqual({ host: 'github.com', owner: 'Acme', repo: 'web' })
    expect(await resolvePrimaryRepoRef(repoWithRemotes({ upstream: 'git@github.com:acme/api.git' })))
      .toEqual({ host: 'github.com', owner: 'acme', repo: 'api' })
  })

  test('a repository with no remote has none', async () => {
    expect(await resolvePrimaryRepoRef(repoWithRemotes({}))).toBeNull()
  })
})
