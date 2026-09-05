import { execFile } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
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

/**
 * Reading a Chrome profile's cookies.
 *
 * Every value is encrypted with a key Chrome keeps in the operating system's
 * credential store, so reading one means asking the OS to unlock something. On
 * macOS that is the `Chrome Safe Storage` keychain item and a system dialog; on
 * Linux the published fallback key opens `v10` values and a keyring-sealed `v11`
 * value is counted as encrypted; on Windows DPAPI and app-bound encryption
 * refuse other applications outright, so the source is listed as unavailable
 * (ADR 0026).
 */

/** How long the keychain lookup may wait for the user. The dialog blocks until
 *  it is answered, and an unanswered one must become an error rather than a
 *  request that never returns under an RPC. */
const KEYCHAIN_TIMEOUT_MS = 60_000

/** Directories under the Chrome root that hold a cookie store but are not a
 *  person's profile. Offering them would be offering an empty or throwaway jar. */
const NOT_A_USER_PROFILE = new Set(['Guest Profile', 'System Profile'])

/** Chromium's own key derivation on macOS and Linux. Fixed by the browser, not
 *  chosen here: these are the numbers that make the ciphertext readable. */
const KEY_SALT = 'saltysalt'
const KEY_LENGTH = 16
const MACOS_ITERATIONS = 1003
const LINUX_ITERATIONS = 1
/** The published fallback password Chromium uses on a Linux box with no keyring. */
const LINUX_FALLBACK_PASSWORD = 'peanuts'
/** AES-128-CBC with an all-spaces IV, again Chromium's choice rather than ours. */
const IV = Buffer.alloc(16, ' ')

/** Chromium's own encoding of the `SameSite` attribute. `-1` is "unspecified". */
const SAME_SITE_BY_CODE = new Map<number, BrowserProfileCookie['sameSite']>([
  [0, 'no_restriction'],
  [1, 'lax'],
  [2, 'strict'],
])

/** Chromium timestamps are microseconds since 1601-01-01. */
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600

const execFileAsync = promisify(execFile)

function profileRoots(): string[] {
  return homeCandidates({
    darwin: [join('Library', 'Application Support', 'Google', 'Chrome')],
    win32: [join('Google', 'Chrome', 'User Data')],
    linux: [
      join('.config', 'google-chrome'),
      join('.var', 'app', 'com.google.Chrome', 'config', 'google-chrome'),
    ],
  })
}

const infoCacheSchema = z.object({
  profile: z.object({
    info_cache: z.record(z.string(), z.object({ name: z.string().optional() })).default({}),
  }).optional(),
})

/**
 * Profile display names, from Chrome's own `Local State`.
 *
 * The directory is `Default` or `Profile 3`, which says nothing about whose
 * account it holds. Chrome records the names the user gave them; an unreadable
 * file leaves the directory name as the label rather than failing the scan.
 */
function profileNames(root: string): Map<string, string> {
  const names = new Map<string, string>()
  try {
    const parsed = infoCacheSchema.safeParse(JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')))
    if (!parsed.success) return names
    for (const [directory, entry] of Object.entries(parsed.data.profile?.info_cache ?? {})) {
      if (entry.name) names.set(directory, entry.name)
    }
  } catch {
    // A profile with no readable index is still importable.
  }
  return names
}

/** Why this platform cannot produce a key, when it cannot. */
function platformBlock(): string | null {
  if (process.platform !== 'win32') return null
  return 'Chrome on Windows seals its cookie key with DPAPI and app-bound encryption, which '
    + 'deliberately refuses other applications. Import from Firefox instead, or sign in inside '
    + 'the Solus browser profile.'
}

export function chromiumProfiles(): CookieSourceDirectory[] {
  const found: CookieSourceDirectory[] = []
  const blocked = platformBlock()
  for (const root of profileRoots()) {
    if (!existsSync(root)) continue
    const names = profileNames(root)
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (NOT_A_USER_PROFILE.has(entry)) continue
      const storePath = join(root, entry, 'Cookies')
      // Chrome moved the store under `Network/` in M96; both are checked so an
      // older profile is not a silent absence.
      const networkPath = join(root, entry, 'Network', 'Cookies')
      const path = existsSync(networkPath) ? networkPath : existsSync(storePath) ? storePath : null
      if (!path) continue
      const id = `chrome:${entry}`
      if (found.some((candidate) => candidate.id === id)) continue
      const directory: CookieSourceDirectory = {
        id,
        browser: 'chrome',
        label: `Chrome — ${names.get(entry) ?? entry}`,
        storePath: path,
      }
      if (blocked) directory.unavailable = blocked
      else if (process.platform === 'darwin') {
        directory.unlockPrompt =
          'macOS will ask once for permission to read Chrome’s key from your keychain.'
      }
      try {
        directory.lastUsedAt = statSync(path).mtimeMs
      } catch {
        // A profile whose mtime cannot be read is still importable.
      }
      found.push(directory)
    }
  }
  return found
}

/**
 * The key Chromium encrypted this host's cookies with.
 *
 * On macOS this is the call that shows the keychain dialog, which is why it
 * happens at import and never during a scan. `security` blocks until the user
 * answers, so an unanswered prompt becomes an error a caller can report rather
 * than a promise that never settles.
 */
export async function chromiumCookieKey(): Promise<Buffer> {
  if (process.platform === 'darwin') {
    let password: string
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/security',
        ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
        { timeout: KEYCHAIN_TIMEOUT_MS },
      )
      password = stdout.trim()
    } catch {
      // Deliberately not carrying the tool's own message: it is the one place a
      // secret could reach a log through an error string.
      throw new Error(
        'macOS did not give Solus the Chrome keychain item. Allow it when the system asks, or '
        + 'import from Firefox instead.',
      )
    }
    if (!password) throw new Error('The Chrome keychain item is empty on this host.')
    return pbkdf2Sync(password, KEY_SALT, MACOS_ITERATIONS, KEY_LENGTH, 'sha1')
  }
  // Linux without a keyring. A profile sealed against libsecret or KWallet
  // simply will not decrypt with this, and those rows are counted as encrypted.
  return pbkdf2Sync(LINUX_FALLBACK_PASSWORD, KEY_SALT, LINUX_ITERATIONS, KEY_LENGTH, 'sha1')
}

/**
 * One cookie value, in the clear.
 *
 * Returns null rather than throwing: a value this key cannot open is one skipped
 * cookie, not a failed import of nine hundred.
 *
 * Only `v10` is attempted. A `v11` value is sealed against a Linux keyring the
 * fallback key does not hold, and trying it anyway is not harmless: CBC padding
 * accepts roughly one wrong key in 256, and that one would import garbage as a
 * cookie. Refusing the version is the honest answer.
 *
 * Chromium ~M118 began prefixing the plaintext with the SHA-256 of the cookie's
 * own host, so the domain is verified and stripped rather than pasted into the
 * value — a cookie carrying 32 bytes of hash in front of its session id is one
 * that silently fails against every request.
 */
export function decryptChromiumValue(
  encrypted: Buffer,
  key: Buffer,
  hostKey: string,
): string | null {
  if (encrypted.length <= 3) return null
  if (encrypted.subarray(0, 3).toString('ascii') !== 'v10') return null
  let plaintext: Buffer
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, IV)
    plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
  } catch {
    return null
  }
  const hostHash = createHash('sha256').update(hostKey).digest()
  if (plaintext.length >= hostHash.length && plaintext.subarray(0, hostHash.length).equals(hostHash)) {
    plaintext = plaintext.subarray(hostHash.length)
  }
  return plaintext.toString('utf8')
}

/** Everything about a row except its value: enough to decide whether it may
 *  cross, which is all a scan needs. */
const metadataRowSchema = z.object({
  name: z.string(),
  host_key: z.string(),
  path: z.string(),
  expires_utc: z.number(),
  is_secure: z.number(),
  is_httponly: z.number(),
  samesite: z.number(),
  is_persistent: z.number(),
  top_frame_site_key: z.string().default(''),
})

const cookieRowSchema = metadataRowSchema.extend({
  value: z.string(),
  encrypted_value: z.union([z.instanceof(Uint8Array), z.null()]).default(null),
})

const METADATA_COLUMNS =
  'name, host_key, path, expires_utc, is_secure, is_httponly, samesite, is_persistent, top_frame_site_key'

/**
 * Every importable cookie in one Chrome profile.
 *
 * The key is resolved by the caller so that a test can supply one, and so that
 * the keychain prompt has exactly one origin.
 */
export function readChromiumCookies(directory: CookieSourceDirectory, key: Buffer): CookieRead {
  const skipped = emptySkips()
  const cookies: BrowserProfileCookie[] = []
  const nowSeconds = Math.floor(Date.now() / 1000)
  let read = 0

  withCopiedStore(directory.storePath, (db) => {
    for (const raw of db.prepare(`SELECT ${METADATA_COLUMNS}, value, encrypted_value FROM cookies`).all()) {
      read += 1
      const parsed = cookieRowSchema.safeParse(raw)
      if (!parsed.success) {
        skipped.unsupported += 1
        continue
      }
      const cookie = importableCookie(parsed.data, key, nowSeconds, skipped)
      if (cookie) cookies.push(cookie)
    }
  })

  return { cookies, read, skipped }
}

/**
 * How many rows would land, judged on metadata alone: the value columns are
 * never selected, so a scan holds no ciphertext and unlocks no keyring. A value
 * the key later refuses shows up as an `encrypted` skip at import, which is the
 * one way the two numbers can disagree.
 */
export function countChromiumCookies(directory: CookieSourceDirectory): number {
  const nowSeconds = Math.floor(Date.now() / 1000)
  let count = 0
  withCopiedStore(directory.storePath, (db) => {
    for (const raw of db.prepare(`SELECT ${METADATA_COLUMNS} FROM cookies`).all()) {
      const parsed = metadataRowSchema.safeParse(raw)
      if (parsed.success && !rejection(parsed.data, nowSeconds)) count += 1
    }
  })
  return count
}

/** Why a row cannot cross, on metadata alone. Null means it may. */
function rejection(
  row: z.output<typeof metadataRowSchema>,
  nowSeconds: number,
): keyof BrowserCookieSkipCounts | null {
  // Chrome's partitioned storage keys a cookie to the top-level site that set
  // it. The key means nothing in another browser's jar.
  if (row.top_frame_site_key) return 'partitioned'
  if (!row.name || !row.host_key) return 'unsupported'
  if (row.is_persistent !== 0 && row.expires_utc > 0) {
    const expiresAt = Math.floor(row.expires_utc / 1_000_000) - WEBKIT_EPOCH_OFFSET_SECONDS
    if (expiresAt <= nowSeconds) return 'expired'
  }
  return null
}

function importableCookie(
  row: z.output<typeof cookieRowSchema>,
  key: Buffer,
  nowSeconds: number,
  skipped: BrowserCookieSkipCounts,
): BrowserProfileCookie | null {
  const rejected = rejection(row, nowSeconds)
  if (rejected) {
    skipped[rejected] += 1
    return null
  }
  // Modern Chrome leaves `value` empty and puts the real one in
  // `encrypted_value`; a very old profile still has the plain column.
  let value = row.value
  if (!value && row.encrypted_value && row.encrypted_value.length > 0) {
    const opened = decryptChromiumValue(Buffer.from(row.encrypted_value), key, row.host_key)
    if (opened === null) {
      skipped.encrypted += 1
      return null
    }
    value = opened
  }
  const cookie: BrowserProfileCookie = {
    name: row.name,
    value,
    domain: row.host_key,
    path: row.path || '/',
    secure: row.is_secure !== 0,
    httpOnly: row.is_httponly !== 0,
    sameSite: SAME_SITE_BY_CODE.get(row.samesite) ?? 'lax',
  }
  if (row.is_persistent !== 0 && row.expires_utc > 0) {
    cookie.expiresAt = Math.floor(row.expires_utc / 1_000_000) - WEBKIT_EPOCH_OFFSET_SECONDS
  }
  return cookie
}
