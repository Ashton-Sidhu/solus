import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { BrowserCookieSkipCounts } from '@solus/contracts/browser-types'
import type { BrowserProfileCookie } from './surface-driver'
import {
  emptySkips,
  homeCandidates,
  withCopiedStore,
  type CookieRead,
  type CookieSourceDirectory,
} from './cookie-sources'

/** Reading a Firefox profile's cookies. `cookies.sqlite` is plain, so this
 *  reader touches no keyring and can never prompt the user. */

/** Firefox's own encoding of the `SameSite` attribute. */
const SAME_SITE_BY_CODE = new Map<number, BrowserProfileCookie['sameSite']>([
  [0, 'no_restriction'],
  [1, 'lax'],
  [2, 'strict'],
])

/** `schemeMap` is a bitmask: 1 http, 2 https, 4 file. A cookie that only ever
 *  applied to `file://` has no meaning in a profile that browses dev servers. */
const SCHEME_FILE_ONLY = 4

function profileRoots(): string[] {
  return homeCandidates({
    darwin: [join('Library', 'Application Support', 'Firefox')],
    win32: [join('Mozilla', 'Firefox')],
    linux: [
      join('.mozilla', 'firefox'),
      join('snap', 'firefox', 'common', '.mozilla', 'firefox'),
      join('.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
    ],
  })
}

/**
 * Profile display names, from Firefox's own index.
 *
 * The directory name is a random prefix plus a suffix (`8fj2k1.default-release`),
 * which tells a user with two profiles nothing. `profiles.ini` holds the names
 * they chose; it is a plain INI file, and an unreadable or absent one simply
 * leaves the directory name as the label rather than failing the scan.
 */
function profileNames(root: string): Map<string, string> {
  const names = new Map<string, string>()
  const iniPath = join(root, 'profiles.ini')
  if (!existsSync(iniPath)) return names
  let text: string
  try {
    text = readFileSync(iniPath, 'utf8')
  } catch {
    return names
  }
  let name: string | null = null
  let path: string | null = null
  const flush = (): void => {
    if (name && path) names.set(path.split(/[\\/]/).pop() ?? path, name)
    name = null
    path = null
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      flush()
      continue
    }
    const at = line.indexOf('=')
    if (at === -1) continue
    const key = line.slice(0, at).trim().toLowerCase()
    if (key === 'name') name = line.slice(at + 1).trim()
    else if (key === 'path') path = line.slice(at + 1).trim()
  }
  flush()
  return names
}

export function firefoxProfiles(): CookieSourceDirectory[] {
  const found: CookieSourceDirectory[] = []
  for (const root of profileRoots()) {
    if (!existsSync(root)) continue
    const names = profileNames(root)
    // Firefox 60+ puts profiles under `Profiles/`; older and some Linux packages
    // put them directly in the root. Both are scanned, so neither layout is a
    // silent "no sources found".
    for (const container of [join(root, 'Profiles'), root]) {
      if (!existsSync(container)) continue
      let entries: string[]
      try {
        entries = readdirSync(container)
      } catch {
        continue
      }
      for (const entry of entries) {
        const storePath = join(container, entry, 'cookies.sqlite')
        if (!existsSync(storePath)) continue
        const id = `firefox:${entry}`
        if (found.some((candidate) => candidate.id === id)) continue
        const directory: CookieSourceDirectory = {
          id,
          browser: 'firefox',
          label: `Firefox — ${names.get(entry) ?? entry.replace(/^[^.]*\./, '')}`,
          storePath,
        }
        // When the store was last written is the only honest "is this the one I
        // use" signal available without reading a single cookie.
        try {
          directory.lastUsedAt = statSync(storePath).mtimeMs
        } catch {
          // A profile whose mtime cannot be read is still importable.
        }
        found.push(directory)
      }
    }
  }
  return found
}

/** Everything about a row except its value: enough to decide whether it may
 *  cross, which is all a scan needs. */
const metadataRowSchema = z.object({
  name: z.string(),
  host: z.string(),
  path: z.string(),
  expiry: z.number(),
  isSecure: z.number(),
  isHttpOnly: z.number(),
  sameSite: z.number(),
  schemeMap: z.number(),
  originAttributes: z.string(),
})

const cookieRowSchema = metadataRowSchema.extend({ value: z.string() })

const METADATA_COLUMNS = 'name, host, path, expiry, isSecure, isHttpOnly, sameSite, schemeMap, originAttributes'

export function readFirefoxCookies(directory: CookieSourceDirectory): CookieRead {
  const skipped = emptySkips()
  const cookies: BrowserProfileCookie[] = []
  const nowSeconds = Math.floor(Date.now() / 1000)
  let read = 0

  withCopiedStore(directory.storePath, (db) => {
    for (const raw of db.prepare(`SELECT ${METADATA_COLUMNS}, value FROM moz_cookies`).all()) {
      read += 1
      const parsed = cookieRowSchema.safeParse(raw)
      if (!parsed.success) {
        skipped.unsupported += 1
        continue
      }
      const rejected = rejection(parsed.data, nowSeconds)
      if (rejected) {
        skipped[rejected] += 1
        continue
      }
      cookies.push(importableCookie(parsed.data))
    }
  })

  return { cookies, read, skipped }
}

/** How many rows would land, judged on metadata alone: the value column is
 *  never selected, so a scan holds no cookie in memory. */
export function countFirefoxCookies(directory: CookieSourceDirectory): number {
  const nowSeconds = Math.floor(Date.now() / 1000)
  let count = 0
  withCopiedStore(directory.storePath, (db) => {
    for (const raw of db.prepare(`SELECT ${METADATA_COLUMNS} FROM moz_cookies`).all()) {
      const parsed = metadataRowSchema.safeParse(raw)
      if (parsed.success && !rejection(parsed.data, nowSeconds)) count += 1
    }
  })
  return count
}

/**
 * Why a row cannot cross. Null means it may.
 *
 * Every rejection is counted under a named reason rather than dropped quietly:
 * "imported 412 of 900" with no explanation is indistinguishable from a broken
 * importer, and the reasons here are the ones a user can act on.
 */
function rejection(
  row: z.output<typeof metadataRowSchema>,
  nowSeconds: number,
): keyof BrowserCookieSkipCounts | null {
  const attributes = row.originAttributes.trim()
  if (attributes) {
    if (attributes.includes('partitionKey=')) return 'partitioned'
    if (attributes.includes('userContextId=') || attributes.includes('privateBrowsingId=')) return 'container'
    return 'unsupported'
  }
  if (row.expiry > 0 && row.expiry <= nowSeconds) return 'expired'
  if (!row.name || !row.host || row.schemeMap === SCHEME_FILE_ONLY) return 'unsupported'
  return null
}

function importableCookie(row: z.output<typeof cookieRowSchema>): BrowserProfileCookie {
  const cookie: BrowserProfileCookie = {
    name: row.name,
    value: row.value,
    domain: row.host,
    path: row.path || '/',
    secure: row.isSecure !== 0,
    httpOnly: row.isHttpOnly !== 0,
    sameSite: SAME_SITE_BY_CODE.get(row.sameSite) ?? 'lax',
  }
  if (row.expiry > 0) cookie.expiresAt = row.expiry
  return cookie
}
