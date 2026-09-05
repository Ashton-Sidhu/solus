import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import {
  BROWSER_DEFAULT_PROFILE_ID,
  BROWSER_PARTITION_PREFIX,
  browserPartition,
  browserProfileIdFor,
  browserProfilePartition,
  isBrowserProfileId,
} from '@solus/contracts/browser-types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

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

describe('the automatic profile is exactly the one that already exists', () => {
  test('the default profile resolves to the project partition, byte for byte', () => {
    // WHY: every login obtained before named profiles existed lives in this
    // partition. A profile scheme that decorated the default name would sign
    // every user out of every project on upgrade.
    expect(browserProfilePartition(ALPHA, BROWSER_DEFAULT_PROFILE_ID)).toBe(browserPartition(ALPHA))
    expect(browserProfilePartition(ALPHA, undefined)).toBe(browserPartition(ALPHA))
    expect(browserProfilePartition(undefined, BROWSER_DEFAULT_PROFILE_ID)).toBe(BROWSER_PARTITION_PREFIX)
  })

  test('a project always has its default profile, with no row behind it', () => {
    const set = profiles.browserProfiles(ALPHA)
    expect(set.profiles).toEqual([
      { id: BROWSER_DEFAULT_PROFILE_ID, name: 'Default', createdAt: 0, builtIn: true },
    ])
    expect(set.defaultProfileId).toBe(BROWSER_DEFAULT_PROFILE_ID)
  })

  test('the default profile can be neither renamed nor deleted', () => {
    // WHY: it is the project's own jar rather than a row. "Clear browser data"
    // is its reverse state; deleting it would be deleting the project's browser.
    expect(() => profiles.renameBrowserProfile(ALPHA, BROWSER_DEFAULT_PROFILE_ID, 'Mine')).toThrow()
    expect(() => profiles.deleteBrowserProfileRow(ALPHA, BROWSER_DEFAULT_PROFILE_ID)).toThrow()
  })
})

describe('a named profile is a second jar inside the same project', () => {
  test('a name becomes an id, and the id becomes a partition of its own', () => {
    profiles.createBrowserProfile(ALPHA, 'Admin account')
    const set = profiles.browserProfiles(ALPHA)

    expect(set.profiles.map((profile) => profile.id)).toEqual([BROWSER_DEFAULT_PROFILE_ID, 'admin-account'])
    const partition = browserProfilePartition(ALPHA, 'admin-account')
    expect(partition).not.toBe(browserPartition(ALPHA))
    expect(partition.startsWith(BROWSER_PARTITION_PREFIX)).toBe(true)
  })

  test('a profile of one project cannot be addressed as another project’s', () => {
    // WHY: profiles are per project because logins are. A partition scheme that
    // let two projects collide would hand one project's session to another.
    profiles.createBrowserProfile(ALPHA, 'Admin')
    expect(profiles.browserProfiles(BETA).profiles).toHaveLength(1)
    expect(profiles.browserProfileExists(BETA, 'admin')).toBe(false)
    expect(browserProfilePartition(ALPHA, 'admin')).not.toBe(browserProfilePartition(BETA, 'admin'))
  })

  test('a named partition cannot be mistaken for another project’s default', () => {
    // WHY: `browserPartition` emits base-36 digits after the prefix. Without a
    // separating segment, a profile named like one of those hashes on a page with
    // no project root would address that project's jar.
    const hostless = browserProfilePartition(undefined, 'k3f9zq')
    expect(hostless).toBe(`${BROWSER_PARTITION_PREFIX}-p-k3f9zq`)
    expect(hostless).not.toBe(browserPartition('/projects/whatever'))
  })

  test('renaming keeps the id, because the id is where the login lives', () => {
    profiles.createBrowserProfile(ALPHA, 'Admin')
    const before = browserProfilePartition(ALPHA, 'admin')

    const set = profiles.renameBrowserProfile(ALPHA, 'admin', 'Support desk')

    expect(set.profiles.at(-1)).toMatchObject({ id: 'admin', name: 'Support desk' })
    expect(browserProfilePartition(ALPHA, 'admin')).toBe(before)
  })

  test('a name with nothing usable in it is refused rather than numbered', () => {
    // WHY: the id becomes a partition segment and a directory name on a
    // Playwright host. Inventing one for "###" would produce a profile the user
    // cannot recognise in either place.
    expect(browserProfileIdFor('###')).toBe('')
    expect(() => profiles.createBrowserProfile(ALPHA, '###')).toThrow()
    expect(() => profiles.createBrowserProfile(ALPHA, '   ')).toThrow()
    expect(() => profiles.createBrowserProfile(ALPHA, 'a'.repeat(200))).toThrow()
  })

  test('ids stay inside the set a partition and a directory name can carry', () => {
    expect(isBrowserProfileId('admin-account')).toBe(true)
    expect(isBrowserProfileId('Admin')).toBe(false)
    expect(isBrowserProfileId('../escape')).toBe(false)
    expect(isBrowserProfileId('-leading')).toBe(false)
    expect(isBrowserProfileId('')).toBe(false)
  })

  test('two profiles cannot share a name in one project', () => {
    profiles.createBrowserProfile(ALPHA, 'Admin')
    expect(() => profiles.createBrowserProfile(ALPHA, 'admin')).toThrow()
  })

  test('a profile cannot be created that shadows the built-in default', () => {
    expect(() => profiles.createBrowserProfile(ALPHA, 'Default')).toThrow()
  })
})

describe('which identity a new page opens as', () => {
  test('an unstated profile takes the project’s chosen default', () => {
    profiles.createBrowserProfile(ALPHA, 'Admin')
    expect(profiles.profileForOpen(ALPHA, undefined)).toBe(BROWSER_DEFAULT_PROFILE_ID)

    profiles.setBrowserDefaultProfile(ALPHA, 'admin')
    expect(profiles.profileForOpen(ALPHA, undefined)).toBe('admin')
    expect(profiles.profileForOpen(BETA, undefined)).toBe(BROWSER_DEFAULT_PROFILE_ID)
  })

  test('a profile this project does not have is refused, not created', () => {
    // WHY: a page opened on a jar with no record is a login nothing can later
    // list, clear, or delete.
    expect(() => profiles.profileForOpen(ALPHA, 'ghost')).toThrow('No browser profile ghost')
  })

  test('the default survives a restart, because it is what new pages take', () => {
    profiles.createBrowserProfile(ALPHA, 'Admin')
    profiles.setBrowserDefaultProfile(ALPHA, 'admin')

    db.closeDb()

    expect(profiles.browserProfiles(ALPHA).defaultProfileId).toBe('admin')
  })
})

describe('deleting a profile', () => {
  test('removes the row and takes the default pointer with it', () => {
    // WHY: a default left pointing at a deleted profile would open every new page
    // on a jar that no longer exists.
    profiles.createBrowserProfile(ALPHA, 'Admin')
    profiles.setBrowserDefaultProfile(ALPHA, 'admin')

    const set = profiles.deleteBrowserProfileRow(ALPHA, 'admin')

    expect(set.profiles.map((profile) => profile.id)).toEqual([BROWSER_DEFAULT_PROFILE_ID])
    expect(set.defaultProfileId).toBe(BROWSER_DEFAULT_PROFILE_ID)
  })

  test('a profile that is not there is an error rather than a silent success', () => {
    expect(() => profiles.deleteBrowserProfileRow(ALPHA, 'ghost')).toThrow()
  })

  test('one project’s deletion leaves another project’s profiles alone', () => {
    profiles.createBrowserProfile(ALPHA, 'Admin')
    profiles.createBrowserProfile(BETA, 'Admin')

    profiles.deleteBrowserProfileRow(ALPHA, 'admin')

    expect(profiles.browserProfileExists(BETA, 'admin')).toBe(true)
  })
})

describe('a page keeps one identity across every surface that renders it', () => {
  test('the renderer and the host mint the profile partition the same way', () => {
    // WHY: the native `<webview>` is created by the renderer and the headless
    // guest by the host. A page whose two hosts disagreed about the partition
    // name would lose its login on every migration between them — which is what
    // happens whenever a desktop pane opens or closes over a page an agent drives.
    const layer = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/components/browser/BrowserWebviewLayer.svelte'),
      'utf8',
    )
    expect(layer).toContain('partition={browserProfilePartition(')
    expect(layer).toContain('entry.page.profileId')
    // The project-only form would put every profile of a project in one jar.
    expect(layer).not.toContain('partition={browserPartition(')
  })

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
    })

    expect(registry.partitionOf(page)).toBe(browserProfilePartition(ALPHA, 'admin'))
    expect(registry.pagesOnPartition(browserProfilePartition(ALPHA, 'admin'))).toHaveLength(1)
    // The project's own jar holds no page, which is what makes deleting the
    // named profile a question about exactly one signed-in page.
    expect(registry.pagesOnPartition(browserPartition(ALPHA))).toHaveLength(0)
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
    })).toThrow('Not a browser profile id')
    await registry.shutdown()
  })
})
