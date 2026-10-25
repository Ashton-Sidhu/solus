import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import {
  BROWSER_DEFAULT_PROFILE_ID,
  BROWSER_PARTITION_PREFIX,
  BROWSER_UNSAVED_PARTITION_PREFIX,
  browserPartition,
  browserProfileIdFor,
  browserProfilePartition,
  isBrowserProfileId,
} from '@solus/contracts/browser-types'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/**
 * Named browser profiles.
 *
 * One project, several signed-in identities: the admin account and the customer
 * account of the same app, both against one dev server. The rules below are the
 * ones that decide whether a user keeps a login they obtained by hand — every
 * failure here loses one.
 */

type DbModule = typeof import('@solus/server/db')
type ProfilesModule = typeof import('@solus/server/browser/browser-profiles')

let dataDir: string
let db: DbModule
let profiles: ProfilesModule
const previousDataDir = process.env.SOLUS_DATA_DIR

const ALPHA = '/projects/alpha'
const BETA = '/projects/beta'
const ALICE = 'acct_alice'
const BOB = 'acct_bob'

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-browser-profiles-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  profiles = await import('@solus/server/browser/browser-profiles')
})

afterEach(() => {
  db.closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('every profile is one person’s (member-isolation.md §6)', () => {
  test('the default profile is per project and per person', () => {
    // WHY: one project-wide jar signed bob's agent in as alice. The default jar
    // now names the person, so two people in one project never share it.
    const alice = browserProfilePartition(ALPHA, BROWSER_DEFAULT_PROFILE_ID, ALICE)
    expect(browserProfilePartition(ALPHA, undefined, ALICE)).toBe(alice)
    expect(alice).not.toBe(browserProfilePartition(ALPHA, BROWSER_DEFAULT_PROFILE_ID, BOB))
    expect(alice).not.toBe(browserPartition(ALPHA))
    expect(alice.startsWith(`${browserPartition(ALPHA)}-u-`)).toBe(true)
  })

  test('a person key becomes a safe partition segment that no other key shares', () => {
    // WHY: the partition is a directory name on a Playwright host. A key with a
    // slash or a colon must not escape it, and keys that differ only in case must
    // not meet on a case-insensitive disk.
    const partition = browserProfilePartition(ALPHA, 'admin', 'guest:A/b')
    expect(partition).toMatch(/^persist:solus-browser-[a-z0-9]+-u-[0-9a-f]+-p-admin$/)
    expect(browserProfilePartition(ALPHA, 'admin', 'acct_A')).not.toBe(browserProfilePartition(ALPHA, 'admin', 'acct_a'))
  })

  test("the host's own work gets an unsaved jar, never a person's", () => {
    // WHY: work for nobody must not sign in as somebody. The unsaved jar has no
    // `persist:` prefix, so Electron keeps it in memory, and the hosts refuse to
    // import into it or clear it.
    const unsaved = browserProfilePartition(ALPHA, BROWSER_DEFAULT_PROFILE_ID, null)
    expect(unsaved.startsWith(BROWSER_UNSAVED_PARTITION_PREFIX)).toBe(true)
    expect(unsaved.startsWith(BROWSER_PARTITION_PREFIX)).toBe(false)
    expect(profiles.profileForOpen(null, ALPHA, undefined)).toBe(BROWSER_DEFAULT_PROFILE_ID)
    profiles.createBrowserProfile(ALICE, ALPHA, 'Admin')
    expect(() => profiles.profileForOpen(null, ALPHA, 'admin')).toThrow("host's own work")
  })

  test("bob cannot list, open, rename, default, or delete alice's profile", () => {
    profiles.createBrowserProfile(ALICE, ALPHA, 'Admin')

    expect(profiles.browserProfiles(BOB, ALPHA).profiles.map((profile) => profile.id)).toEqual([BROWSER_DEFAULT_PROFILE_ID])
    expect(profiles.browserProfileExists(BOB, ALPHA, 'admin')).toBe(false)
    expect(() => profiles.profileForOpen(BOB, ALPHA, 'admin')).toThrow('No browser profile admin')
    expect(() => profiles.renameBrowserProfile(BOB, ALPHA, 'admin', 'Mine')).toThrow('No browser profile admin')
    expect(() => profiles.setBrowserDefaultProfile(BOB, ALPHA, 'admin')).toThrow('No browser profile admin')
    expect(() => profiles.deleteBrowserProfileRow(BOB, ALPHA, 'admin')).toThrow('No browser profile admin')
    expect(profiles.browserProfiles(ALICE, ALPHA).profiles.at(-1)).toMatchObject({ id: 'admin', name: 'Admin' })
  })

  test('two people may use the same profile name, each with their own jar', () => {
    profiles.createBrowserProfile(ALICE, ALPHA, 'Admin')
    profiles.createBrowserProfile(BOB, ALPHA, 'Admin')
    profiles.setBrowserDefaultProfile(ALICE, ALPHA, 'admin')

    expect(profiles.profileForOpen(BOB, ALPHA, undefined)).toBe(BROWSER_DEFAULT_PROFILE_ID)
    expect(browserProfilePartition(ALPHA, 'admin', ALICE)).not.toBe(browserProfilePartition(ALPHA, 'admin', BOB))
  })
})

describe('the automatic profile is always there', () => {
  test('a project always has its default profile, with no row behind it', () => {
    const set = profiles.browserProfiles(ALICE, ALPHA)
    expect(set.profiles).toEqual([
      { id: BROWSER_DEFAULT_PROFILE_ID, name: 'Default', createdAt: 0, builtIn: true },
    ])
    expect(set.defaultProfileId).toBe(BROWSER_DEFAULT_PROFILE_ID)
  })

  test('the default profile can be neither renamed nor deleted', () => {
    // WHY: it is the project's own jar rather than a row. "Clear browser data"
    // is its reverse state; deleting it would be deleting the project's browser.
    expect(() => profiles.renameBrowserProfile(ALICE, ALPHA, BROWSER_DEFAULT_PROFILE_ID, 'Mine')).toThrow()
    expect(() => profiles.deleteBrowserProfileRow(ALICE, ALPHA, BROWSER_DEFAULT_PROFILE_ID)).toThrow()
  })
})

describe('a named profile is a second jar inside the same project', () => {
  test('a name becomes an id, and the id becomes a partition of its own', () => {
    profiles.createBrowserProfile(ALICE, ALPHA, 'Admin account')
    const set = profiles.browserProfiles(ALICE, ALPHA)

    expect(set.profiles.map((profile) => profile.id)).toEqual([BROWSER_DEFAULT_PROFILE_ID, 'admin-account'])
    const partition = browserProfilePartition(ALPHA, 'admin-account', ALICE)
    expect(partition).not.toBe(browserPartition(ALPHA))
    expect(partition.startsWith(BROWSER_PARTITION_PREFIX)).toBe(true)
  })

  test('a profile of one project cannot be addressed as another project’s', () => {
    // WHY: profiles are per project because logins are. A partition scheme that
    // let two projects collide would hand one project's session to another.
    profiles.createBrowserProfile(ALICE, ALPHA, 'Admin')
    expect(profiles.browserProfiles(ALICE, BETA).profiles).toHaveLength(1)
    expect(profiles.browserProfileExists(ALICE, BETA, 'admin')).toBe(false)
    expect(browserProfilePartition(ALPHA, 'admin', ALICE)).not.toBe(browserProfilePartition(BETA, 'admin', ALICE))
  })

  test('a named partition cannot be mistaken for another project’s default', () => {
    // WHY: `browserPartition` emits base-36 digits after the prefix. Without a
    // separating segment, a profile named like one of those hashes on a page with
    // no project root would address that project's jar.
    const hostless = browserProfilePartition(undefined, 'k3f9zq', ALICE)
    expect(hostless.endsWith('-p-k3f9zq')).toBe(true)
    expect(hostless).not.toBe(browserPartition('/projects/whatever'))
  })

  test('renaming keeps the id, because the id is where the login lives', () => {
    profiles.createBrowserProfile(ALICE, ALPHA, 'Admin')
    const before = browserProfilePartition(ALPHA, 'admin', ALICE)

    const set = profiles.renameBrowserProfile(ALICE, ALPHA, 'admin', 'Support desk')

    expect(set.profiles.at(-1)).toMatchObject({ id: 'admin', name: 'Support desk' })
    expect(browserProfilePartition(ALPHA, 'admin', ALICE)).toBe(before)
  })

  test('a name with nothing usable in it is refused rather than numbered', () => {
    // WHY: the id becomes a partition segment and a directory name on a
    // Playwright host. Inventing one for "###" would produce a profile the user
    // cannot recognise in either place.
    expect(browserProfileIdFor('###')).toBe('')
    expect(() => profiles.createBrowserProfile(ALICE, ALPHA, '###')).toThrow()
    expect(() => profiles.createBrowserProfile(ALICE, ALPHA, '   ')).toThrow()
    expect(() => profiles.createBrowserProfile(ALICE, ALPHA, 'a'.repeat(200))).toThrow()
  })

  test('ids stay inside the set a partition and a directory name can carry', () => {
    expect(isBrowserProfileId('admin-account')).toBe(true)
    expect(isBrowserProfileId('Admin')).toBe(false)
    expect(isBrowserProfileId('../escape')).toBe(false)
    expect(isBrowserProfileId('-leading')).toBe(false)
    expect(isBrowserProfileId('')).toBe(false)
  })

  test('two profiles cannot share a name in one project', () => {
    profiles.createBrowserProfile(ALICE, ALPHA, 'Admin')
    expect(() => profiles.createBrowserProfile(ALICE, ALPHA, 'admin')).toThrow()
  })

  test('a profile cannot be created that shadows the built-in default', () => {
    expect(() => profiles.createBrowserProfile(ALICE, ALPHA, 'Default')).toThrow()
  })
})

describe('which identity a new page opens as', () => {
  test('an unstated profile takes the project’s chosen default', () => {
    profiles.createBrowserProfile(ALICE, ALPHA, 'Admin')
    expect(profiles.profileForOpen(ALICE, ALPHA, undefined)).toBe(BROWSER_DEFAULT_PROFILE_ID)

    profiles.setBrowserDefaultProfile(ALICE, ALPHA, 'admin')
    expect(profiles.profileForOpen(ALICE, ALPHA, undefined)).toBe('admin')
    expect(profiles.profileForOpen(ALICE, BETA, undefined)).toBe(BROWSER_DEFAULT_PROFILE_ID)
  })

  test('a profile this project does not have is refused, not created', () => {
    // WHY: a page opened on a jar with no record is a login nothing can later
    // list, clear, or delete.
    expect(() => profiles.profileForOpen(ALICE, ALPHA, 'ghost')).toThrow('No browser profile ghost')
  })

  test('the default survives a restart, because it is what new pages take', () => {
    profiles.createBrowserProfile(ALICE, ALPHA, 'Admin')
    profiles.setBrowserDefaultProfile(ALICE, ALPHA, 'admin')

    db.closeDb()

    expect(profiles.browserProfiles(ALICE, ALPHA).defaultProfileId).toBe('admin')
  })
})

describe('deleting a profile', () => {
  test('removes the row and takes the default pointer with it', () => {
    // WHY: a default left pointing at a deleted profile would open every new page
    // on a jar that no longer exists.
    profiles.createBrowserProfile(ALICE, ALPHA, 'Admin')
    profiles.setBrowserDefaultProfile(ALICE, ALPHA, 'admin')

    const set = profiles.deleteBrowserProfileRow(ALICE, ALPHA, 'admin')

    expect(set.profiles.map((profile) => profile.id)).toEqual([BROWSER_DEFAULT_PROFILE_ID])
    expect(set.defaultProfileId).toBe(BROWSER_DEFAULT_PROFILE_ID)
  })

  test('a profile that is not there is an error rather than a silent success', () => {
    expect(() => profiles.deleteBrowserProfileRow(ALICE, ALPHA, 'ghost')).toThrow()
  })

  test('one project’s deletion leaves another project’s profiles alone', () => {
    profiles.createBrowserProfile(ALICE, ALPHA, 'Admin')
    profiles.createBrowserProfile(ALICE, BETA, 'Admin')

    profiles.deleteBrowserProfileRow(ALICE, ALPHA, 'admin')

    expect(profiles.browserProfileExists(ALICE, BETA, 'admin')).toBe(true)
  })
})

describe('a page keeps one identity across every surface that renders it', () => {
  test('the registry mints it from the page, so a headless guest is the same identity', async () => {
    const { initBrowserRegistry } = await import('@solus/server/browser/browser-registry')
    const registry = initBrowserRegistry({
      pageChanged: () => {},
      pageClosed: () => {},
      surfaceRequested: () => {},
    })

    const page = registry.open({
      target: { kind: 'url', url: 'http://localhost:5173/', projectRoot: ALPHA },
      profileId: 'admin',
    }, ALICE)

    expect(registry.partitionOf(page)).toBe(browserProfilePartition(ALPHA, 'admin', ALICE))
    expect(registry.pagesOnPartition(browserProfilePartition(ALPHA, 'admin', ALICE))).toHaveLength(1)
    // The project's own jar holds no page, which is what makes deleting the
    // named profile a question about exactly one signed-in page.
    expect(registry.pagesOnPartition(browserPartition(ALPHA))).toHaveLength(0)
    await registry.shutdown()
  })

  test("a page uses its owner's jar, and only its owner drives it", async () => {
    // WHY: a page acts with its owner's cookies. If bob could drive alice's page,
    // he would act signed in as alice; watching it is all he may do.
    const { initBrowserRegistry } = await import('@solus/server/browser/browser-registry')
    const registry = initBrowserRegistry({ pageChanged: () => {}, pageClosed: () => {}, surfaceRequested: () => {} })
    const target = { kind: 'url' as const, url: 'http://localhost:5173/', projectRoot: ALPHA }

    const alicePage = registry.open({ target }, ALICE)
    const hostPage = registry.open({ target }, null)

    expect(alicePage.ownerKey).toBe(ALICE)
    expect(registry.partitionOf(alicePage)).toBe(browserProfilePartition(ALPHA, undefined, ALICE))
    expect(registry.partitionOf(hostPage).startsWith(BROWSER_UNSAVED_PARTITION_PREFIX)).toBe(true)
    expect(() => registry.assertDrivableBy(alicePage.browserPageId, ALICE)).not.toThrow()
    expect(() => registry.assertDrivableBy(alicePage.browserPageId, BOB)).toThrow('another person')
    expect(() => registry.assertDrivableBy(hostPage.browserPageId, BOB)).toThrow('another person')
    expect(() => registry.assertDrivableBy(alicePage.browserPageId, null)).toThrow('another person')
    // Everyone still lists it: a page is watched by anyone who may use the browser.
    expect(registry.list().map((page) => page.browserPageId)).toContain(alicePage.browserPageId)
    await registry.shutdown()
  })

  test('the registry refuses an identity that is not a legal partition segment', async () => {
    // WHY: the id becomes a partition name and, on a Playwright host, a directory
    // under the data dir. One that escaped either would be a path traversal.
    const { initBrowserRegistry } = await import('@solus/server/browser/browser-registry')
    const registry = initBrowserRegistry({
      pageChanged: () => {},
      pageClosed: () => {},
      surfaceRequested: () => {},
    })

    expect(() => registry.open({
      target: { kind: 'url', url: 'http://localhost:5173/', projectRoot: ALPHA },
      profileId: '../../escape',
    }, ALICE)).toThrow('Not a browser profile id')
    await registry.shutdown()
  })
})

describe('who hears that a person’s profiles changed', () => {
  test("only the owner's connections: not another member, not the host owner", async () => {
    // WHY: the event carries the whole profile set. Sent to everyone, bob's
    // pane would list alice's profiles, which is the list this change hides.
    const { eventVisibleTo } = await import('@solus/server/sharing/event-audience')
    const { userKey } = await import('@solus/contracts/user')
    const { memberPrincipal } = await import('./helpers/actors')
    const alice = memberPrincipal('alice', 'Alice')
    const bob = memberPrincipal('bob', 'Bob')
    const owner = { kind: 'owner' as const, via: 'local' as const, expiresAt: null, deviceId: null, deviceLabel: 'Desktop' }
    const shares = { roleFor: async () => 'none' } as unknown as import('@solus/server/sharing/share-manager').ShareManager
    const event = {
      type: 'browser.profilesChanged' as const,
      payload: { ownerKey: userKey({ kind: 'account', accountId: 'alice' }), profiles: { profiles: [], defaultProfileId: BROWSER_DEFAULT_PROFILE_ID } },
      occurredAt: 0,
    }

    expect(await eventVisibleTo(alice, event, shares)).toBe(true)
    expect(await eventVisibleTo(bob, event, shares)).toBe(false)
    expect(await eventVisibleTo(owner, event, shares)).toBe(false)
  })
})

describe('the profile RPCs act for the caller alone', () => {
  test("bob cannot list, rename, clear, delete, or import into alice's profile", async () => {
    // WHY: the methods name a project and a profile id, which is unique only per
    // person. Each handler reads the caller from the acting scope, so bob's call
    // reaches bob's rows and bob's jar, never alice's.
    const { registerBrowserHandlers } = await import('@solus/server/transport/handlers/browser-handlers')
    const { BrowserFrameChannel } = await import('@solus/server/browser/browser-frame-channel')
    const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')
    const { captureActingScope, withActingScope } = await import('@solus/server/vault/acting-scope')
    const surface = await import('@solus/server/browser/surface-driver')
    actAsHostForTests()
    const host = captureActingScope()
    if (!host) throw new Error('no host scope')
    const as = <T>(personKey: string, fn: () => T): T => withActingScope({ identity: host.identity, personKey }, fn)

    const cleared: string[] = []
    surface.setBrowserProfileHost({ clearProfile: async (partition) => { cleared.push(partition) }, importCookies: async () => ({ imported: 0, failed: 0 }) })
    const handlers = new Map<string, (args: unknown[]) => Promise<unknown>>()
    const broadcasts: { ownerKey: string }[] = []
    const server = { register: (method: string, handler: (args: unknown[]) => Promise<unknown>) => { handlers.set(method, handler) } }
    const events = { broadcast: (_type: string, payload: { ownerKey: string }) => { broadcasts.push(payload); return Promise.resolve(1) } }
    // SAFETY: the test drives the handlers by name; only `register` and `broadcast` are read.
    const registry = registerBrowserHandlers(server as never, { events: events as never, frames: new BrowserFrameChannel() })
    const call = (personKey: string, method: string, ...args: unknown[]) => as(personKey, () => handlers.get(method)!(args))

    await call(ALICE, 'browserCreateProfile', ALPHA, 'Admin')
    expect(broadcasts.at(-1)?.ownerKey).toBe(ALICE)

    const bobList = await call(BOB, 'browserListProfiles', ALPHA) as { profiles: { id: string }[] }
    expect(bobList.profiles.map((profile) => profile.id)).toEqual([BROWSER_DEFAULT_PROFILE_ID])
    await expect(call(BOB, 'browserRenameProfile', ALPHA, 'admin', 'Mine')).rejects.toThrow('No browser profile admin')
    await expect(call(BOB, 'browserImportCookies', { sourceId: 'firefox:x', projectRoot: ALPHA, profileId: 'admin', consent: true })).rejects.toThrow('No browser profile admin')
    await expect(call(BOB, 'browserClearProfile', ALPHA, 'admin')).rejects.toThrow('No browser profile admin')
    await call(BOB, 'browserClearProfile', ALPHA, BROWSER_DEFAULT_PROFILE_ID)
    expect(cleared).toEqual([browserProfilePartition(ALPHA, BROWSER_DEFAULT_PROFILE_ID, BOB)])
    await expect(call(BOB, 'browserDeleteProfile', ALPHA, 'admin')).rejects.toThrow('No browser profile admin')
    expect(cleared).not.toContain(browserProfilePartition(ALPHA, 'admin', ALICE))
    expect(profiles.browserProfileExists(ALICE, ALPHA, 'admin')).toBe(true)

    // A page alice opened is in her jar; bob watches it but cannot drive it.
    const page = await call(ALICE, 'browserOpen', { target: { kind: 'url', url: 'http://localhost:5173/', projectRoot: ALPHA } }) as { browserPageId: string; ownerKey: string }
    expect(page.ownerKey).toBe(ALICE)
    expect((await call(BOB, 'browserListPages') as unknown[]).length).toBe(1)
    await expect(call(BOB, 'browserNavigate', page.browserPageId, { kind: 'reload' })).rejects.toThrow('another person')
    await expect(call(BOB, 'browserAttachSurface', page.browserPageId, 1)).rejects.toThrow('another person')
    await expect(call(BOB, 'browserClose', page.browserPageId)).rejects.toThrow('another person')
    surface.setBrowserProfileHost(null)
    await registry.shutdown()
  })
})
