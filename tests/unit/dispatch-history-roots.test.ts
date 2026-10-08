import { afterAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { dispatchCheckoutOwnerKey, dispatchCheckoutPath, resolveDispatchHistoryRoots } = await import('@solus/server/project-config/dispatch-checkouts')
const { adoptProvisionedLink, resetHostCategoryForTests } = await import('@solus/server/host/host-category')

const roots: string[] = []

function projectsRootWithCheckout(repoKey: string, originUrl: string, ownerKey = 'device-1'): { projectsRoot: string; checkout: string } {
  const projectsRoot = mkdtempSync(path.join(tmpdir(), 'solus-dispatch-roots-'))
  roots.push(projectsRoot)
  const checkout = dispatchCheckoutPath(projectsRoot, ownerKey, repoKey)
  mkdirSync(checkout, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: checkout })
  execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: checkout })
  return { projectsRoot, checkout }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

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

describe('dispatch checkout owner', () => {
  const member = (userId: string, deviceId: string) => ({
    kind: 'org-member' as const, userId, organizationId: 'org1', organizationRole: 'member' as const, teamIds: [], hostKind: 'managed' as const, displayName: userId, deviceId, expiresAt: 0, deviceLabel: 'Web',
  })

  test('on a Solus-provisioned machine a member has one clone per repository, whatever device asks', async () => {
    // WHY: plan 004 item 8. A member who dispatches from a laptop and then a
    // phone must work in the same clone, and never in another member's.
    adoptProvisionedLink({ organizationId: 'org1' })
    try {
      expect(dispatchCheckoutOwnerKey(member('alice', 'laptop'), 'laptop')).toBe('alice')
      expect(dispatchCheckoutOwnerKey(member('alice', 'phone'), 'phone')).toBe('alice')
      expect(dispatchCheckoutOwnerKey(member('bob', 'laptop-b'), 'laptop-b')).toBe('bob')

      const repoKey = 'github.com/acme/web'
      const { projectsRoot, checkout } = projectsRootWithCheckout(repoKey, 'https://github.com/acme/web.git', 'alice')
      expect(await resolveDispatchHistoryRoots(projectsRoot, dispatchCheckoutOwnerKey(member('alice', 'phone'), 'phone'), [repoKey])).toEqual([{ repoKey, path: checkout }])
      expect(await resolveDispatchHistoryRoots(projectsRoot, dispatchCheckoutOwnerKey(member('bob', 'laptop-b'), 'laptop-b'), [repoKey])).toEqual([])
    } finally {
      resetHostCategoryForTests()
    }
  })

  test('elsewhere each paired device keeps its own clone, as before', () => {
    expect(dispatchCheckoutOwnerKey(member('alice', 'laptop'), 'laptop')).toBe('laptop')
    expect(dispatchCheckoutOwnerKey({ kind: 'local-owner', deviceId: 'mac', deviceLabel: 'Mac' }, 'mac')).toBe('mac')
  })
})
