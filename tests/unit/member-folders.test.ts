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
// apart by a suffix; a member who predates named folders keeps their id folder.

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

  test('a member\'s projects live under their name; the same name gets a suffix', () => {
    const { projects } = setup()
    expect(projectsRootFor(member('u1', 'Ada Lovelace'), projects)).toBe(join(projects, 'ada-lovelace'))
    expect(projectsRootFor(member('u2', 'Ada Lovelace'), projects)).toBe(join(projects, 'ada-lovelace-2'))
    expect(projectsRootFor(member('u3', 'ada lovelace'), projects)).toBe(join(projects, 'ada-lovelace-3'))
    // A rename keeps the folder.
    expect(projectsRootFor(member('u1', 'Ada King'), projects)).toBe(join(projects, 'ada-lovelace'))
    expect(memberUserIdOf('ada-lovelace-2')).toBe('u2')
  })

  test('a name the owner\'s own project already uses is not taken', () => {
    const { projects } = setup()
    mkdirSync(join(projects, 'solus'))
    expect(memberFolderFor('u1', 'Solus')).toBe('solus-2')
  })

  test('a member who already had a folder under their id keeps it', () => {
    const { projects } = setup()
    mkdirSync(join(projects, 'u1'))
    expect(projectsRootFor(member('u1', 'Ada'), projects)).toBe(join(projects, 'u1'))
    expect(memberFolderFor('u1', 'Ada')).toBe('u1')
  })

  test('without a name nothing is fixed: the folder is the id until the name arrives', () => {
    setup()
    expect(memberFolderFor('u1')).toBe('u1')
    expect(memberFolderFor('u1', 'Ada')).toBe('ada')
    expect(memberFolderFor('u1')).toBe('ada')
  })

  test('the folder survives a restart', () => {
    const { db, projects, root } = setup()
    expect(memberFolderFor('u1', 'Ada')).toBe('ada')
    useMemberFolders(new MemberFolders({ db, roots: () => [projects, join(root, 'seats', 'claude')] }))
    expect(memberFolderFor('u1', 'Someone Else')).toBe('ada')
  })

  test('a dispatch checkout is under the member\'s name and reads back to their account', () => {
    const { projects } = setup()
    const memberRoot = projectsRootFor(member('u1', 'Ada'), projects)
    const checkout = dispatchCheckoutPath(memberRoot, 'u1', 'github.com/acme/app')
    expect(checkout).toContain('/ada/')
    expect(checkout.split('/')).not.toContain('u1')
    expect(dispatchCheckoutOwnerKeyOf(checkout)).toBe('u1')
    // A paired device's key is no member's: it stays as it is.
    expect(recordedMemberFolder('device.1')).toBe('device.1')
    expect(dispatchCheckoutOwnerKeyOf(dispatchCheckoutPath(projects, 'device.1', 'github.com/acme/app'))).toBe('device.1')
  })
})
