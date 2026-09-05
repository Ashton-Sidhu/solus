import { z } from 'zod'
import {
  BROWSER_DEFAULT_PROFILE_ID,
  BROWSER_DEFAULT_PROFILE_NAME,
  BROWSER_PROFILE_NAME_MAX,
  browserProfileIdFor,
  browserProfilePartition,
  isBrowserProfileId,
  type BrowserCookieImportRequest,
  type BrowserCookieImportResult,
  type BrowserProfile,
  type BrowserProfileSet,
} from '@solus/contracts/browser-types'
import { getDb } from '../db'
import { createLogger } from '../logger'
import { readCookieSource, resolveCookieSource } from './cookie-sources'
import { browserProfileHost } from './surface-driver'

/**
 * A project's named browser identities (ADR 0023).
 *
 * The project's automatic profile has no row. It is the partition
 * `browserPartition` has always produced, synthesised into every answer as the
 * built-in default, so every login obtained before named profiles existed stays
 * exactly where it was.
 */

const log = createLogger('browser', 'browser-profiles.ts')

/** A key rather than the raw value, so `undefined` and `''` are one row. Pages
 *  with no project root all share the hostless jar, and so do its profiles. */
function projectKey(projectRoot: string | undefined): string {
  return projectRoot ?? ''
}

function builtInProfile(): BrowserProfile {
  return { id: BROWSER_DEFAULT_PROFILE_ID, name: BROWSER_DEFAULT_PROFILE_NAME, createdAt: 0, builtIn: true }
}

/** Rows are I/O like any other. Parsed rather than asserted, so a hand-edited
 *  database cannot put a number where a profile name belongs. */
const profileRowSchema = z.object({
  profile_id: z.string(),
  name: z.string(),
  created_at: z.number(),
})

const defaultRowSchema = z.object({ profile_id: z.string() })

export function browserProfiles(projectRoot: string | undefined): BrowserProfileSet {
  const key = projectKey(projectRoot)
  const rows = profileRowSchema.array().parse(getDb()
    .prepare('SELECT profile_id, name, created_at FROM browser_profiles WHERE project_root = ? ORDER BY created_at, profile_id')
    .all(key))
  const profiles: BrowserProfile[] = [
    builtInProfile(),
    ...rows.map((row) => ({ id: row.profile_id, name: row.name, createdAt: row.created_at, builtIn: false })),
  ]
  const chosen = defaultRowSchema.nullable().parse(getDb()
    .prepare('SELECT profile_id FROM browser_profile_defaults WHERE project_root = ?')
    .get(key) ?? null)
  // A default pointing at a profile that was deleted out from under it is not an
  // error state to preserve: new pages fall back to the project's own jar.
  const defaultProfileId = chosen && profiles.some((profile) => profile.id === chosen.profile_id)
    ? chosen.profile_id
    : BROWSER_DEFAULT_PROFILE_ID
  const set: BrowserProfileSet = { profiles, defaultProfileId }
  if (projectRoot) set.projectRoot = projectRoot
  return set
}

/** True for the built-in default and for any named profile this project owns. */
export function browserProfileExists(projectRoot: string | undefined, profileId: string): boolean {
  if (profileId === BROWSER_DEFAULT_PROFILE_ID) return true
  return browserProfiles(projectRoot).profiles.some((profile) => profile.id === profileId)
}

/**
 * The identity a page should open as: the project's chosen default when none
 * was named, and a refusal for one this project does not have — a page opened
 * on a jar with no record would be a login nothing could later clear or delete.
 * Answered here rather than in the registry, which owns pages, not identities.
 */
export function profileForOpen(projectRoot: string | undefined, profileId: string | undefined): string {
  if (!profileId) return browserProfiles(projectRoot).defaultProfileId
  if (!browserProfileExists(projectRoot, profileId)) {
    throw new Error(`No browser profile ${profileId} in this project.`)
  }
  return profileId
}

function validateName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (!trimmed) throw new Error('A browser profile needs a name.')
  if (trimmed.length > BROWSER_PROFILE_NAME_MAX) {
    throw new Error(`A browser profile name may be at most ${BROWSER_PROFILE_NAME_MAX} characters.`)
  }
  return trimmed
}

export function createBrowserProfile(projectRoot: string | undefined, name: string): BrowserProfileSet {
  const key = projectKey(projectRoot)
  const label = validateName(name)
  const id = browserProfileIdFor(label)
  // The id is a partition segment and, on a Playwright host, a directory name.
  // A name that survives none of that is rejected rather than given a number.
  if (!id || !isBrowserProfileId(id)) {
    throw new Error(`"${label}" has no letters or digits to make a profile id from.`)
  }
  if (id === BROWSER_DEFAULT_PROFILE_ID) {
    throw new Error(`"${BROWSER_DEFAULT_PROFILE_NAME}" is the project's own profile and already exists.`)
  }
  const existing = getDb()
    .prepare('SELECT profile_id FROM browser_profiles WHERE project_root = ? AND profile_id = ?')
    .get(key, id)
  if (existing) throw new Error(`This project already has a browser profile called "${label}".`)
  getDb()
    .prepare('INSERT INTO browser_profiles (project_root, profile_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run(key, id, label, Date.now())
  log.info('browser_profile_created', { profileId: id })
  return browserProfiles(projectRoot)
}

/** Renaming changes the label only. The id is the partition the jar already
 *  lives in, so minting a new one would silently sign the profile out. */
export function renameBrowserProfile(
  projectRoot: string | undefined,
  profileId: string,
  name: string,
): BrowserProfileSet {
  const key = projectKey(projectRoot)
  if (profileId === BROWSER_DEFAULT_PROFILE_ID) {
    throw new Error("The project's own browser profile cannot be renamed.")
  }
  const label = validateName(name)
  const changed = getDb()
    .prepare('UPDATE browser_profiles SET name = ? WHERE project_root = ? AND profile_id = ?')
    .run(label, key, profileId)
  if (changed.changes === 0) throw new Error(`No browser profile ${profileId} in this project.`)
  return browserProfiles(projectRoot)
}

/**
 * Forget a profile's row.
 *
 * The caller clears the jar itself first — this is only the record, and a row
 * removed while its cookies survived would leave an unreachable signed-in
 * partition on disk.
 */
export function deleteBrowserProfileRow(projectRoot: string | undefined, profileId: string): BrowserProfileSet {
  const key = projectKey(projectRoot)
  if (profileId === BROWSER_DEFAULT_PROFILE_ID) {
    throw new Error("The project's own browser profile cannot be deleted. Clear its data instead.")
  }
  const changed = getDb()
    .prepare('DELETE FROM browser_profiles WHERE project_root = ? AND profile_id = ?')
    .run(key, profileId)
  if (changed.changes === 0) throw new Error(`No browser profile ${profileId} in this project.`)
  getDb()
    .prepare('DELETE FROM browser_profile_defaults WHERE project_root = ? AND profile_id = ?')
    .run(key, profileId)
  log.info('browser_profile_deleted', { profileId })
  return browserProfiles(projectRoot)
}

export function setBrowserDefaultProfile(
  projectRoot: string | undefined,
  profileId: string,
): BrowserProfileSet {
  const key = projectKey(projectRoot)
  if (!browserProfileExists(projectRoot, profileId)) {
    throw new Error(`No browser profile ${profileId} in this project.`)
  }
  if (profileId === BROWSER_DEFAULT_PROFILE_ID) {
    getDb().prepare('DELETE FROM browser_profile_defaults WHERE project_root = ?').run(key)
  } else {
    getDb()
      .prepare(`
        INSERT INTO browser_profile_defaults (project_root, profile_id) VALUES (?, ?)
        ON CONFLICT (project_root) DO UPDATE SET profile_id = excluded.profile_id
      `)
      .run(key, profileId)
  }
  return browserProfiles(projectRoot)
}

/**
 * Copy one browser profile's cookies into one Solus browser profile.
 *
 * This is the enforcement point for what ADR 0025 decided: the source is an id
 * the host minted, never a path; the destination must be a profile this project
 * owns; the consent flag is required rather than inferred, because importing is
 * the moment an agent gains the ability to act as the user's signed-in self; and
 * nothing but counts crosses back or reaches a log line.
 */
export async function importBrowserCookies(
  request: BrowserCookieImportRequest,
): Promise<BrowserCookieImportResult> {
  if (request.consent !== true) {
    throw new Error('Importing cookies needs the explicit consent flag: agents driving this profile act as you.')
  }
  const host = browserProfileHost()
  if (!host) throw new Error('This host holds no browser profiles, so there is nowhere to import cookies to.')
  if (!browserProfileExists(request.projectRoot, request.profileId)) {
    throw new Error(`No browser profile ${request.profileId} in this project.`)
  }
  const source = resolveCookieSource(request.sourceId)
  // The one call that may unlock a keychain, reached only after consent has
  // been checked and the destination has been proved to exist.
  const { cookies, read, skipped } = await readCookieSource(source)
  const partition = browserProfilePartition(request.projectRoot, request.profileId)
  const { imported, failed } = await host.importCookies(partition, cookies)
  log.info('browser_cookies_imported', {
    profileId: request.profileId,
    browser: source.browser,
    read,
    imported,
    failed,
    expired: skipped.expired,
    partitioned: skipped.partitioned,
    container: skipped.container,
    encrypted: skipped.encrypted,
    unsupported: skipped.unsupported,
  })
  return { profileId: request.profileId, read, imported, skipped, failed }
}
