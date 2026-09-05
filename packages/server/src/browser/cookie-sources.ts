import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  BrowserCookieBrowser,
  BrowserCookieSkipCounts,
  BrowserCookieSource,
  BrowserCookieSourceScan,
} from '@solus/contracts/browser-types'
import { createLogger } from '../logger'
import type { BrowserProfileCookie } from './surface-driver'
import {
  chromiumCookieKey,
  chromiumProfiles,
  countChromiumCookies,
  readChromiumCookies,
} from './chromium-cookies'
import { countFirefoxCookies, firefoxProfiles, readFirefoxCookies } from './firefox-cookies'
import { countSafariCookies, readSafariCookies, safariProfiles } from './safari-cookies'

/**
 * The browsers on this host whose cookies could be copied into a Solus profile
 * (ADR 0026). A source is chosen by id from a list this file produced, and every
 * reader answers the same two questions: how many cookies would land, and which
 * ones. Nothing here is reachable from an agent.
 */

const log = createLogger('browser', 'cookie-sources.ts')

/** One readable profile, as the reader that found it describes it. */
export interface CookieSourceDirectory {
  /** `<browser>:<profile>`, so two browsers cannot mint the same id. */
  id: string
  browser: BrowserCookieBrowser
  label: string
  /** The store this reader would open. Never leaves the host. */
  storePath: string
  lastUsedAt?: number
  /** Set when the store was found but cannot be read here. */
  unavailable?: string
  /** Set when reading will make the operating system ask the user for something. */
  unlockPrompt?: string
}

export interface CookieRead {
  cookies: BrowserProfileCookie[]
  read: number
  skipped: BrowserCookieSkipCounts
}

export function emptySkips(): BrowserCookieSkipCounts {
  return { expired: 0, partitioned: 0, container: 0, encrypted: 0, unsupported: 0 }
}

/** Where a browser keeps its profiles, per platform. Several candidates because
 *  a Linux install may be the distribution's, a Snap, or a Flatpak. */
export function homeCandidates(paths: { darwin: string[]; win32: string[]; linux: string[] }): string[] {
  const home = homedir()
  const parts = process.platform === 'darwin'
    ? paths.darwin
    : process.platform === 'win32' ? paths.win32 : paths.linux
  if (process.platform === 'win32') {
    // Chrome lives under LOCALAPPDATA and Firefox under APPDATA. Each segment is
    // tried under both; the one that does not exist is skipped by the caller.
    const roots = [process.env.LOCALAPPDATA, process.env.APPDATA].filter((root): root is string => !!root)
    return parts.flatMap((part) => roots.map((root) => join(root, part)))
  }
  return parts.map((part) => join(home, part))
}

/**
 * Open a consistent copy of a live SQLite cookie store.
 *
 * The `-wal` and `-shm` journals travel with the main file: without them a copy
 * taken mid-transaction is missing every commit still in the log, which for a
 * browser that has been running all day is most of the session. SQLite recovers
 * the copy on open, which is why the copy is opened rather than the original —
 * recovery is a write, and the user's own browser owns that file.
 *
 * Shared by the Firefox and Chrome readers because the hazard is the same one.
 */
export function withCopiedStore(sourcePath: string, use: (db: DatabaseSync) => void): void {
  const scratch = mkdtempSync(join(tmpdir(), 'solus-cookie-read-'))
  let db: DatabaseSync | null = null
  try {
    const copyPath = join(scratch, 'store.sqlite')
    copyFileSync(sourcePath, copyPath)
    for (const suffix of ['-wal', '-shm']) {
      const journal = `${sourcePath}${suffix}`
      if (existsSync(journal)) copyFileSync(journal, `${copyPath}${suffix}`)
    }
    db = new DatabaseSync(copyPath)
    use(db)
  } finally {
    db?.close()
    // The copy holds the user's cookies. It does not outlive the read that
    // needed it, including when that read threw.
    rmSync(scratch, { recursive: true, force: true })
  }
}

function allProfiles(): CookieSourceDirectory[] {
  return [...firefoxProfiles(), ...chromiumProfiles(), ...safariProfiles()]
}

/**
 * What this host could import from. A found-but-blocked source is listed with
 * its reason rather than hidden; only a host with no supported browser at all
 * answers `supported: false`. Counts come from row metadata, never a value, so
 * opening this list cannot make macOS ask for a keychain password.
 */
export function discoverCookieSources(): BrowserCookieSourceScan {
  const directories = allProfiles()
  if (directories.length === 0) {
    return {
      supported: false,
      unavailable:
        'No Firefox, Chrome, or Safari profile was found on this host. Cookie import reads a browser '
        + 'installed on the machine that renders your browser pages.',
      sources: [],
    }
  }
  const sources = directories.map(sourceOf)
  // Most recently used first: with several browsers installed, the one the user
  // actually works in is the one they are looking for.
  sources.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
  return { supported: true, sources }
}

function sourceOf(directory: CookieSourceDirectory): BrowserCookieSource {
  const source: BrowserCookieSource = {
    id: directory.id,
    label: directory.label,
    browser: directory.browser,
    importable: directory.unavailable ? 0 : countCookies(directory),
  }
  if (directory.lastUsedAt !== undefined) source.lastUsedAt = Math.round(directory.lastUsedAt)
  if (directory.unavailable) source.unavailable = directory.unavailable
  if (directory.unlockPrompt) source.unlockPrompt = directory.unlockPrompt
  return source
}

/**
 * Resolve a client's source id against what this host actually has.
 *
 * The client names a source; it never names a path. A path from a client would
 * make this a "read any file on the host" RPC, which is not what an import is.
 */
export function resolveCookieSource(sourceId: string): CookieSourceDirectory {
  const directory = allProfiles().find((candidate) => candidate.id === sourceId)
  if (!directory) throw new Error(`No browser profile ${sourceId} on this host.`)
  if (directory.unavailable) throw new Error(directory.unavailable)
  return directory
}

/** Every importable cookie in one profile. The one call that may unlock a
 *  keyring, which is why nothing on the scan path reaches it. Asynchronous
 *  because Chrome's key is a process away. */
export async function readCookieSource(directory: CookieSourceDirectory): Promise<CookieRead> {
  if (directory.browser === 'firefox') return readFirefoxCookies(directory)
  if (directory.browser === 'safari') return readSafariCookies(directory)
  return readChromiumCookies(directory, await chromiumCookieKey())
}

/** How many rows would land, judged on metadata alone. Never decrypts, so a
 *  scan cannot prompt. */
function countCookies(directory: CookieSourceDirectory): number {
  try {
    if (directory.browser === 'firefox') return countFirefoxCookies(directory)
    if (directory.browser === 'safari') return countSafariCookies(directory)
    return countChromiumCookies(directory)
  } catch (error) {
    log.warn('browser_cookie_source_unreadable', {
      browser: directory.browser,
      message: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
}
