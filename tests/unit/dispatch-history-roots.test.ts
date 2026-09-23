import { afterAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { dispatchCheckoutPath, resolveDispatchHistoryRoots } = await import('@solus/server/project-config/dispatch-checkouts')

const roots: string[] = []

function projectsRootWithCheckout(repoKey: string, originUrl: string): { projectsRoot: string; checkout: string } {
  const projectsRoot = mkdtempSync(path.join(tmpdir(), 'solus-dispatch-roots-'))
  roots.push(projectsRoot)
  const checkout = dispatchCheckoutPath(projectsRoot, 'device-1', repoKey)
  mkdirSync(checkout, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: checkout })
  execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: checkout })
  return { projectsRoot, checkout }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('resolveDispatchHistoryRoots', () => {
  test('finds a GitLab subgroup checkout by its full repository key', async () => {
    // WHY: the client asks with the §1 key, which keeps every path segment.
    // An owner/repo reduction of the checkout's remote never matched it, so
    // history for a subgroup repository was lost on the target host.
    const repoKey = 'gitlab.com/group/sub/repo'
    const { projectsRoot, checkout } = projectsRootWithCheckout(repoKey, 'git@gitlab.com:group/sub/repo.git')
    expect(await resolveDispatchHistoryRoots(projectsRoot, 'device-1', [repoKey])).toEqual([{ repoKey, path: checkout }])
  })

  test('ignores a checkout whose remote names another repository', async () => {
    const { projectsRoot } = projectsRootWithCheckout('github.com/acme/web', 'https://github.com/acme/other.git')
    expect(await resolveDispatchHistoryRoots(projectsRoot, 'device-1', ['github.com/acme/web'])).toEqual([])
  })
})
