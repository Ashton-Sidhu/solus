import { afterAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { dispatchCheckoutOwnerKey, dispatchCheckoutOwnerKeyOf, dispatchCheckoutPath, isDispatchClone, resolveDispatchHistoryRoots } = await import('@solus/server/project-config/dispatch-checkouts')
const { adoptProvisionedRegistration, resetHostCategoryForTests } = await import('@solus/server/host/host-category')

const roots: string[] = []

function projectsRootWithCheckout(repoKey: string, originUrl: string): { projectsRoot: string; checkout: string } {
  const projectsRoot = mkdtempSync(path.join(tmpdir(), 'solus-dispatch-roots-'))
  roots.push(projectsRoot)
  const checkout = dispatchCheckoutPath(projectsRoot, repoKey)
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
    expect(resolveDispatchHistoryRoots(projectsRoot, [repoKey])).toEqual([{ repoKey, path: checkout }])
  })

  test('ignores a checkout whose remote names another repository', async () => {
    const { projectsRoot } = projectsRootWithCheckout('github.com/acme/web', 'https://github.com/acme/other.git')
    expect(resolveDispatchHistoryRoots(projectsRoot, ['github.com/acme/web'])).toEqual([])
  })
})

describe('dispatch checkout owner', () => {
  const member = (userId: string, deviceId: string) => ({
    kind: 'org-member' as const, userId, organizationId: 'org1', organizationRole: 'member' as const, teamIds: [], hostKind: 'managed' as const, displayName: userId, deviceId, expiresAt: 0, deviceLabel: 'Web',
  })

  test('on a Solus-provisioned machine a member has one clone per repository, whatever device asks', async () => {
    // WHY: plan 004 item 8. A member who dispatches from a laptop and then a
    // phone must work in the same clone, and never in another member's.
    adoptProvisionedRegistration({ organizationId: 'org1' })
    try {
      expect(dispatchCheckoutOwnerKey(member('alice', 'laptop'), 'laptop')).toBe('alice')
      expect(dispatchCheckoutOwnerKey(member('alice', 'phone'), 'phone')).toBe('alice')
      expect(dispatchCheckoutOwnerKey(member('bob', 'laptop-b'), 'laptop-b')).toBe('bob')

      // Each member's projects folder is their own (`projectsRootFor`), so
      // Bob asks in his and never finds Alice's clone.
      const repoKey = 'github.com/acme/web'
      const alice = projectsRootWithCheckout(repoKey, 'https://github.com/acme/web.git')
      const bobRoot = mkdtempSync(path.join(tmpdir(), 'solus-dispatch-roots-'))
      roots.push(bobRoot)
      expect(resolveDispatchHistoryRoots(alice.projectsRoot, [repoKey])).toEqual([{ repoKey, path: alice.checkout }])
      expect(resolveDispatchHistoryRoots(bobRoot, [repoKey])).toEqual([])
    } finally {
      resetHostCategoryForTests()
    }
  })

  test('elsewhere each paired device keeps its own clone, as before', () => {
    expect(dispatchCheckoutOwnerKey(member('alice', 'laptop'), 'laptop')).toBe('laptop')
    expect(dispatchCheckoutOwnerKey({ kind: 'owner', via: 'local', expiresAt: null, deviceId: 'mac', deviceLabel: 'Mac' }, 'mac')).toBe('mac')
  })
})

describe('where a dispatch clone goes (docs/plans/dispatch-clone-folder.md)', () => {
  function emptyRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'solus-dispatch-folder-'))
    roots.push(root)
    return root
  }
  function checkoutAt(dir: string, originUrl: string): void {
    mkdirSync(dir, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: dir })
  }

  test('a new clone is named for its repository in the projects folder', () => {
    // WHY: the host's own project discovery finds it there, and a person can
    // find it on the machine without knowing a device id.
    const root = emptyRoot()
    expect(dispatchCheckoutPath(root, 'github.com/acme/web')).toBe(path.join(root, 'web'))
  })

  test('a checkout of the same repository is used; a folder holding another one is skipped', () => {
    // WHY: two devices of one person share the clone, and Solus never writes
    // into a folder that holds someone else's repository.
    const root = emptyRoot()
    checkoutAt(path.join(root, 'web'), 'https://github.com/other/web.git')
    expect(dispatchCheckoutPath(root, 'github.com/acme/web')).toBe(path.join(root, 'web-2'))
    checkoutAt(path.join(root, 'web-2'), 'git@github.com:acme/web.git')
    expect(dispatchCheckoutPath(root, 'github.com/acme/web')).toBe(path.join(root, 'web-2'))
  })

  test('the delegated owner is read from the clone\'s git config', async () => {
    // WHY: the GitHub API must act as the person whose helper git uses.
    const root = emptyRoot()
    const clone = path.join(root, 'web')
    checkoutAt(clone, 'https://github.com/acme/web.git')
    expect(await dispatchCheckoutOwnerKeyOf(clone)).toBeNull()
    execFileSync('git', ['config', '--local', 'solus.delegationOwner', 'device-1'], { cwd: clone })
    expect(await dispatchCheckoutOwnerKeyOf(clone)).toBe('device-1')
  })

  test('only a clone Solus made counts as one, so a checkout a person made keeps their git config', () => {
    // WHY: Solus writes the delegated helper and commit identity into its own
    // clones. Writing them into your own checkout would change how your pushes
    // there sign in.
    const root = emptyRoot()
    const own = path.join(root, 'web')
    checkoutAt(own, 'https://github.com/acme/web.git')
    expect(isDispatchClone(own)).toBe(false)
    execFileSync('git', ['config', '--local', 'solus.dispatchClone', 'true'], { cwd: own })
    expect(isDispatchClone(own)).toBe(true)
  })

  test('a checkout is found whatever the case of its folder and its origin', () => {
    // WHY: a client names the repository in lower case (`hello-world`), and a
    // person's own checkout is `Hello-World` with origin `.../Hello-World.git`.
    // A file system that keeps case must still find it, not clone beside it.
    const root = emptyRoot()
    const own = path.join(root, 'Hello-World')
    checkoutAt(own, 'https://github.com/octocat/Hello-World.git')
    expect(dispatchCheckoutPath(root, 'github.com/octocat/hello-world')).toBe(own)
  })
})

