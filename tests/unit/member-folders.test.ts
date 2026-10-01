import { afterEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Principal } from '@solus/server/admission/principal'

// bun has no node:sqlite; the handlers' import chain reaches the db even though these tests never open it.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { MemberFolders, memberFolderFor, memberFolderName, memberUserIdOf, recordedMemberFolder, useMemberFolders } = await import('@solus/server/host/member-folders')
const { projectsRootFor } = await import('@solus/server/transport/handlers/setup-handlers')
const { dispatchCheckoutOwnerKeyOf, dispatchCheckoutPath } = await import('@solus/server/project-config/dispatch-checkouts')

// Every member folder on a host (projects, seats, dispatch checkouts, Git
// credentials) is named after its member; two people with one name are told
// apart by the start of their account id; a member who predates named folders keeps their id folder.

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  useMemberFolders(null)
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'member-folders-'))
  roots.push(root)
  const projects = join(root, 'projects')
  mkdirSync(projects, { recursive: true })
  // bun has no node:sqlite; its own Database speaks the same prepare/get/all/run/exec surface.
  const db = new Database(':memory:') as unknown as DatabaseSync
  const folders = new MemberFolders({ db, roots: () => [projects, join(root, 'seats', 'claude')] })
  useMemberFolders(folders)
  return { root, projects, db, folders }
}

/** Better Auth account ids. */
const ADA = 'K3x9Q2ZfHr8TvL1mNa0bCd4eGh5jKl6p'
const OTHER_ADA = 'p7Wm4cXq2Rt9Yu8Io7Pa6Sd5Fg4Hj3Kl'

const member = (userId: string, displayName: string): Principal => ({
  kind: 'org-member', userId, organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'managed',
  displayName, deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud',
})

describe('member folders', () => {
  test('a name becomes a folder name', () => {
    expect(memberFolderName('Ada Lovelace')).toBe('ada-lovelace')
    expect(memberFolderName('José Núñez')).toBe('jose-nunez')
    expect(memberFolderName('  ../Bob  ')).toBe('bob')
    expect(memberFolderName('山田')).toBe('member')
  })

  test('a member\'s projects live under their name and the start of their id', () => {
    const { projects } = setup()
    expect(projectsRootFor(member(ADA, 'Ada Lovelace'), projects)).toBe(join(projects, 'ada-lovelace-k3x9q2'))
    // Another Ada is told apart by their own id, not by arriving second.
    expect(projectsRootFor(member(OTHER_ADA, 'Ada Lovelace'), projects)).toBe(join(projects, 'ada-lovelace-p7wm4c'))
    // A rename keeps the folder.
    expect(projectsRootFor(member(ADA, 'Ada King'), projects)).toBe(join(projects, 'ada-lovelace-k3x9q2'))
    expect(memberUserIdOf('ada-lovelace-p7wm4c')).toBe(OTHER_ADA)
  })

  test('ids that agree on their start, or differ only in case, lengthen the slug', () => {
    setup()
    expect(memberFolderFor('K3X9q2AAAAAA', 'Ada')).toBe('ada-k3x9q2')
    expect(memberFolderFor('k3x9Q2BBBBBB', 'Ada')).toBe('ada-k3x9q2bbbbbb')
  })

  test('a folder already on disk is not taken', () => {
    const { projects } = setup()
    mkdirSync(join(projects, 'solus-k3x9q2'))
    expect(memberFolderFor(ADA, 'Solus')).toBe('solus-k3x9q2zfhr8t')
  })

  test('a long name is cut so the id slug still fits', () => {
    setup()
    const folder = memberFolderFor(ADA, 'A'.repeat(80))
    expect(folder.length).toBeLessThanOrEqual(48)
    expect(folder.endsWith('-k3x9q2')).toBe(true)
  })

  test('a member who already had a folder under their id keeps it', () => {
    const { projects } = setup()
    mkdirSync(join(projects, ADA))
    expect(projectsRootFor(member(ADA, 'Ada'), projects)).toBe(join(projects, ADA))
    expect(memberFolderFor(ADA, 'Ada')).toBe(ADA)
  })

  test('without a name nothing is fixed: the folder is the id until the name arrives', () => {
    setup()
    expect(memberFolderFor(ADA)).toBe(ADA)
    expect(memberFolderFor(ADA, 'Ada')).toBe('ada-k3x9q2')
    expect(memberFolderFor(ADA)).toBe('ada-k3x9q2')
  })

  test('the folder survives a restart', () => {
    const { db, projects, root } = setup()
    expect(memberFolderFor(ADA, 'Ada')).toBe('ada-k3x9q2')
    useMemberFolders(new MemberFolders({ db, roots: () => [projects, join(root, 'seats', 'claude')] }))
    expect(memberFolderFor(ADA, 'Someone Else')).toBe('ada-k3x9q2')
  })

  test('a dispatch checkout is under the member\'s folder and reads back to their account', () => {
    const { projects } = setup()
    const memberRoot = projectsRootFor(member(ADA, 'Ada'), projects)
    const checkout = dispatchCheckoutPath(memberRoot, ADA, 'github.com/acme/app')
    expect(checkout.split('/')).toContain('ada-k3x9q2')
    expect(checkout.split('/')).not.toContain(ADA)
    expect(dispatchCheckoutOwnerKeyOf(checkout)).toBe(ADA)
    // A paired device's key is no member's: it stays as it is.
    expect(recordedMemberFolder('device.1')).toBe('device.1')
    expect(dispatchCheckoutOwnerKeyOf(dispatchCheckoutPath(projects, 'device.1', 'github.com/acme/app'))).toBe('device.1')
  })
})
