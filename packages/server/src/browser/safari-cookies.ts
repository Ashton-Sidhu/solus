import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserCookieSkipCounts } from '@solus/contracts/browser-types'
import type { BrowserProfileCookie } from './surface-driver'
import { emptySkips, type CookieRead, type CookieSourceDirectory } from './cookie-sources'

/**
 * Reading Safari's cookies.
 *
 * The store is plain, but it sits where macOS enforces its own privacy controls:
 * without Full Disk Access the read fails with `EPERM`, and "no Safari" and "no
 * permission" are told apart only by that errno (ADR 0026).
 *
 * The format is `binarycookies` — Apple's own, undocumented but stable, and
 * parsed below rather than shelled out to. Every offset in it comes from the
 * file, so every read is bounds-checked: this is untrusted binary from disk.
 */

const FULL_DISK_ACCESS_REASON =
  'macOS is protecting Safari’s cookies. Give Solus Full Disk Access in System Settings → '
  + 'Privacy & Security → Full Disk Access, then restart it.'

/** Apple's absolute time epoch, 2001-01-01, as a Unix timestamp. */
const MAC_EPOCH_OFFSET_SECONDS = 978_307_200

/** Cookie flag bits. Safari records nothing about `SameSite`. */
const FLAG_SECURE = 0x1
const FLAG_HTTP_ONLY = 0x4

/** A page begins with this marker. A file whose pages do not is not one of
 *  these, whatever its extension says. */
const PAGE_HEADER = 0x0000_0100

/** Both places Safari has kept the store: the sandboxed container it uses now,
 *  and the older unsandboxed path. */
function storeCandidates(): string[] {
  const home = homedir()
  return [
    join(home, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies', 'Cookies.binarycookies'),
    join(home, 'Library', 'Cookies', 'Cookies.binarycookies'),
  ]
}

interface ProbeResult {
  path: string
  lastUsedAt?: number
  unavailable?: string
}

/**
 * Whether this store is there, unreadable, or absent.
 *
 * Opened rather than stat'd, because macOS enforces its privacy protection at
 * `open(2)`: a protected file still stats perfectly well, so a stat-based probe
 * would list Safari as available and then report zero cookies.
 */
function probe(path: string): ProbeResult | null {
  let handle: number | undefined
  try {
    handle = openSync(path, 'r')
    return { path, lastUsedAt: fstatSync(handle).mtimeMs }
  } catch (error) {
    // SAFETY: `openSync` rejects only with a filesystem error, and its code is
    // the whole question here.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      return { path, unavailable: FULL_DISK_ACCESS_REASON }
    }
    return null
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

export function safariProfiles(): CookieSourceDirectory[] {
  if (process.platform !== 'darwin') return []
  for (const candidate of storeCandidates()) {
    const found = probe(candidate)
    if (!found) continue
    const directory: CookieSourceDirectory = {
      id: 'safari:default',
      browser: 'safari',
      label: 'Safari',
      storePath: found.path,
    }
    if (found.lastUsedAt !== undefined) directory.lastUsedAt = found.lastUsedAt
    if (found.unavailable) directory.unavailable = found.unavailable
    // The first candidate that answers wins: a machine with both has the
    // container as the live one.
    return [directory]
  }
  return []
}

export function readSafariCookies(directory: CookieSourceDirectory): CookieRead {
  const skipped = emptySkips()
  const cookies: BrowserProfileCookie[] = []
  const nowSeconds = Math.floor(Date.now() / 1000)
  let read = 0

  let file: Buffer
  try {
    file = readFileSync(directory.storePath)
  } catch (error) {
    // SAFETY: as above — `readFileSync` rejects only with a filesystem error,
    // and a permission one has to become the sentence that names the fix rather
    // than a raw `EPERM` nobody can act on.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') throw new Error(FULL_DISK_ACCESS_REASON)
    throw error
  }

  for (const raw of parseBinaryCookies(file)) {
    read += 1
    const cookie = importableCookie(raw, nowSeconds, skipped)
    if (cookie) cookies.push(cookie)
  }

  return { cookies, read, skipped }
}

/** Safari stores values in the clear, so counting is the same pass without
 *  keeping anything. */
export function countSafariCookies(directory: CookieSourceDirectory): number {
  return readSafariCookies(directory).cookies.length
}

/** One cookie as the file records it, before any Solus rule is applied. */
interface SafariCookie {
  domain: string
  name: string
  path: string
  value: string
  secure: boolean
  httpOnly: boolean
  /** Unix seconds. Zero or negative is a session cookie. */
  expiresAt: number
}

/**
 * Walk the file's pages and cookies.
 *
 * Every length and offset below comes from the file itself, so each one is
 * checked against the buffer before it is used. A malformed page yields nothing
 * and the walk moves to the next: one corrupt page must not cost the cookies in
 * the others.
 */
function parseBinaryCookies(file: Buffer): SafariCookie[] {
  if (file.length < 8 || file.subarray(0, 4).toString('ascii') !== 'cook') return []
  const pageCount = file.readUInt32BE(4)
  // A page table longer than the file is a corrupt header, not a large browser.
  if (pageCount === 0 || 8 + pageCount * 4 > file.length) return []

  const sizes: number[] = []
  for (let index = 0; index < pageCount; index += 1) sizes.push(file.readUInt32BE(8 + index * 4))

  const cookies: SafariCookie[] = []
  let offset = 8 + pageCount * 4
  for (const size of sizes) {
    if (size <= 0 || offset + size > file.length) break
    readPage(file.subarray(offset, offset + size), cookies)
    offset += size
  }
  return cookies
}

function readPage(page: Buffer, into: SafariCookie[]): void {
  if (page.length < 8 || page.readUInt32BE(0) !== PAGE_HEADER) return
  const count = page.readUInt32LE(4)
  if (count === 0 || 8 + count * 4 > page.length) return
  for (let index = 0; index < count; index += 1) {
    const at = page.readUInt32LE(8 + index * 4)
    if (at + 56 > page.length) continue
    const cookie = readCookie(page.subarray(at))
    if (cookie) into.push(cookie)
  }
}

function readCookie(block: Buffer): SafariCookie | null {
  const size = block.readUInt32LE(0)
  if (size < 56 || size > block.length) return null
  const record = block.subarray(0, size)
  const flags = record.readUInt32LE(8)
  const domain = readString(record, record.readUInt32LE(16))
  const name = readString(record, record.readUInt32LE(20))
  const path = readString(record, record.readUInt32LE(24))
  const value = readString(record, record.readUInt32LE(28))
  if (domain === null || name === null || path === null || value === null) return null
  const expiry = record.readDoubleLE(40)
  return {
    domain,
    name,
    path,
    value,
    secure: (flags & FLAG_SECURE) !== 0,
    httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
    expiresAt: Number.isFinite(expiry) ? Math.floor(expiry + MAC_EPOCH_OFFSET_SECONDS) : 0,
  }
}

/** A NUL-terminated string at a file-supplied offset. Null when the offset or
 *  its terminator falls outside the record. */
function readString(record: Buffer, at: number): string | null {
  if (at < 56 || at >= record.length) return null
  const end = record.indexOf(0, at)
  if (end === -1) return null
  return record.subarray(at, end).toString('utf8')
}

/**
 * Which cookies may cross.
 *
 * Safari has no container or partition concept in this file, so the only
 * rejections available are the two that matter everywhere: a cookie whose time
 * has passed, and a row with nothing to address it by.
 */
function importableCookie(
  raw: SafariCookie,
  nowSeconds: number,
  skipped: BrowserCookieSkipCounts,
): BrowserProfileCookie | null {
  if (!raw.name || !raw.domain) {
    skipped.unsupported += 1
    return null
  }
  if (raw.expiresAt > 0 && raw.expiresAt <= nowSeconds) {
    skipped.expired += 1
    return null
  }
  const cookie: BrowserProfileCookie = {
    name: raw.name,
    value: raw.value,
    domain: raw.domain,
    path: raw.path || '/',
    secure: raw.secure,
    httpOnly: raw.httpOnly,
    // Safari records nothing about `SameSite`, and the strict default would
    // break a cookie the user's own browser sends on cross-site navigations.
    sameSite: 'lax',
  }
  if (raw.expiresAt > 0) cookie.expiresAt = raw.expiresAt
  return cookie
}
