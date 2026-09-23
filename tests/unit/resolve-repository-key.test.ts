import { afterAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { resolveRepositoryKey } = await import('@solus/server/git/git-helpers')

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
})
