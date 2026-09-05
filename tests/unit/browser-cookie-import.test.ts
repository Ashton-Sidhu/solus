import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as realOs from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

/**
 * Importing a browser profile's cookies into a Solus browser profile.
 *
 * Three sources, and they are not equally cheap. Firefox stores cookies in the
 * clear. Chrome encrypts every value with a key held in the operating system's
 * keyring, so choosing it costs the user a system prompt. Safari's store is
 * behind macOS's own privacy protection. Each of those differences is a rule a
 * user can be hurt by getting wrong, and each has a test here.
 *
 * Nothing below reads a real browser. Every fixture is synthetic and built in a
 * temporary home directory, because a test that reads the developer's own
 * signed-in sessions is the exact failure this feature has to not have. The
 * Chrome key is likewise the test's own — the keychain is never touched.
 */

/** A home directory of our own. Detection resolves against the *host's* home,
 *  so this is the only way to point it at a fixture rather than at whoever is
 *  running the suite. */
const fakeHome = mkdtempSync(join(realOs.tmpdir(), 'solus-fake-home-'))
const dataDir = mkdtempSync(join(realOs.tmpdir(), 'solus-cookie-import-'))

mock.module('node:os', () => ({ ...realOs, homedir: () => fakeHome }))
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type SourcesModule = typeof import('@solus/server/browser/cookie-sources')
type ChromiumModule = typeof import('@solus/server/browser/chromium-cookies')
type SafariModule = typeof import('@solus/server/browser/safari-cookies')
type ProfilesModule = typeof import('@solus/server/browser/browser-profiles')
type SurfaceModule = typeof import('@solus/server/browser/surface-driver')
type DbModule = typeof import('@solus/server/db')

let sources: SourcesModule
let chromium: ChromiumModule
let safari: SafariModule
let profiles: ProfilesModule
let surface: SurfaceModule
let db: DbModule

const previousDataDir = process.env.SOLUS_DATA_DIR
const PROJECT = '/projects/alpha'
const FIREFOX_DIR = 'p7q2xk.default-release'
const FIREFOX_ID = `firefox:${FIREFOX_DIR}`
const CHROME_ID = 'chrome:Default'
const SAFARI_ID = 'safari:default'
const ON_MACOS = process.platform === 'darwin'

const NOW_SECONDS = Math.floor(Date.now() / 1000)
const FUTURE = NOW_SECONDS + 86_400

/** Chromium's own key derivation, reproduced so the fixture can be encrypted
 *  the way a real profile is — with a password of the test's choosing rather
 *  than one from anybody's keychain. */
const CHROME_KEY = pbkdf2Sync('test-safe-storage', 'saltysalt', 1003, 16, 'sha1')

// ─── Firefox fixture ───

function firefoxRoot(): string {
  if (process.platform === 'darwin') return join(fakeHome, 'Library', 'Application Support', 'Firefox')
  if (process.platform === 'win32') return join(fakeHome, 'Mozilla', 'Firefox')
  return join(fakeHome, '.mozilla', 'firefox')
}

/**
 * A Firefox cookie store with one row per rule the importer has to apply.
 *
 * The eligible rows are first so a count is easy to read; every other row exists
 * because dropping it silently would be indistinguishable from a broken import.
 */
function seedFirefox(): void {
  const root = firefoxRoot()
  const profileDir = join(root, 'Profiles', FIREFOX_DIR)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(root, 'profiles.ini'),
    ['[Profile0]', 'Name=Work', 'IsRelative=1', `Path=Profiles/${FIREFOX_DIR}`, ''].join('\n'),
  )

  const store = new Database(join(profileDir, 'cookies.sqlite'))
  store.exec(`
    CREATE TABLE moz_cookies (
      id INTEGER PRIMARY KEY,
      originAttributes TEXT NOT NULL DEFAULT '',
      name TEXT, value TEXT, host TEXT, path TEXT,
      expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER,
      isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0,
      sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0
    );
  `)
  const insert = store.prepare(`
    INSERT INTO moz_cookies
      (originAttributes, name, value, host, path, expiry, lastAccessed, creationTime,
       isSecure, isHttpOnly, sameSite, schemeMap)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
  `)
  const rows: [string, string | null, string, string, string, number, number, number, number, number][] = [
    // Eligible: a domain cookie on a secure host, and a host-only one.
    ['', 'sid', 'secret-a', '.example.com', '/', FUTURE, 1, 1, 1, 3],
    ['', 'theme', 'dark', 'app.example.com', '/', FUTURE, 0, 0, 2, 3],
    // Expired: past its own expiry, so copying it would produce nothing.
    ['', 'stale', 'secret-b', '.example.com', '/', NOW_SECONDS - 10, 1, 1, 1, 3],
    // Partitioned: keyed to the top-level site that set it.
    ['^partitionKey=%28https%2Cexample.com%29', 'pk', 'secret-c', '.tracker.test', '/', FUTURE, 1, 1, 1, 3],
    // A container tab and a private window: identities the user kept apart.
    ['^userContextId=3', 'work', 'secret-d', '.example.com', '/', FUTURE, 1, 1, 1, 3],
    ['^privateBrowsingId=1', 'temp', 'secret-e', '.example.com', '/', FUTURE, 1, 1, 1, 3],
    // Unsupported: a file-scheme-only cookie, and a row with no name at all.
    ['', 'local', 'secret-f', 'localhost', '/', FUTURE, 0, 0, 1, 4],
    ['', null, 'secret-g', '.example.com', '/', FUTURE, 0, 0, 1, 3],
  ]
  for (const row of rows) insert.run(...row)
  store.close()
}

// ─── Chrome fixture ───

function chromeRoot(): string {
  if (process.platform === 'darwin') {
    return join(fakeHome, 'Library', 'Application Support', 'Google', 'Chrome')
  }
  if (process.platform === 'win32') return join(fakeHome, 'Google', 'Chrome', 'User Data')
  return join(fakeHome, '.config', 'google-chrome')
}

/** Chromium's `v10` envelope: AES-128-CBC under an all-spaces IV, with the
 *  cookie's own host hashed in front of the plaintext since M118. */
function chromeEncrypt(value: string, hostKey: string, withHostHash: boolean): Buffer {
  const cipher = createCipheriv('aes-128-cbc', CHROME_KEY, Buffer.alloc(16, ' '))
  const prefix = withHostHash ? createHash('sha256').update(hostKey).digest() : Buffer.alloc(0)
  const body = Buffer.concat([prefix, Buffer.from(value, 'utf8')])
  return Buffer.concat([Buffer.from('v10'), cipher.update(body), cipher.final()])
}

/** Chromium timestamps are microseconds since 1601-01-01. */
function chromeTime(unixSeconds: number): number {
  return (unixSeconds + 11_644_473_600) * 1_000_000
}

function seedChrome(): void {
  const root = chromeRoot()
  mkdirSync(join(root, 'Default', 'Network'), { recursive: true })
  mkdirSync(join(root, 'Profile 1'), { recursive: true })
  writeFileSync(
    join(root, 'Local State'),
    JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } } } }),
  )

  for (const [directory, store] of [
    ['Default', join(root, 'Default', 'Network', 'Cookies')],
    ['Profile 1', join(root, 'Profile 1', 'Cookies')],
  ] as const) {
    const db = new Database(store)
    db.exec(`
      CREATE TABLE cookies (
        creation_utc INTEGER PRIMARY KEY,
        host_key TEXT, top_frame_site_key TEXT DEFAULT '',
        name TEXT, value TEXT, encrypted_value BLOB,
        path TEXT, expires_utc INTEGER,
        is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
        is_persistent INTEGER, source_scheme INTEGER DEFAULT 2
      );
    `)
    const insert = db.prepare(`
      INSERT INTO cookies
        (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value,
         path, expires_utc, is_secure, is_httponly, samesite, is_persistent)
      VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)
    `)
    if (directory !== 'Default') {
      insert.run(1, '.other.test', '', 'oid', chromeEncrypt('other', '.other.test', true), '/', chromeTime(FUTURE), 1, 1, 1, 1)
      db.close()
      continue
    }
    // Eligible, with and without the host-hash prefix Chrome added in M118.
    insert.run(1, '.example.com', '', 'sid', chromeEncrypt('chrome-a', '.example.com', true), '/', chromeTime(FUTURE), 1, 1, 1, 1)
    insert.run(2, 'app.example.com', '', 'theme', chromeEncrypt('light', 'app.example.com', false), '/', 0, 0, 0, 2, 0)
    // Expired.
    insert.run(3, '.example.com', '', 'stale', chromeEncrypt('chrome-b', '.example.com', true), '/', chromeTime(NOW_SECONDS - 10), 1, 1, 1, 1)
    // Partitioned by the top-level site that set it.
    insert.run(4, '.tracker.test', 'https://example.com', 'pk', chromeEncrypt('chrome-c', '.tracker.test', true), '/', chromeTime(FUTURE), 1, 1, 1, 1)
    // A value this key cannot open — what a Linux keyring or Windows app-bound
    // envelope looks like from here.
    insert.run(5, '.example.com', '', 'sealed', Buffer.concat([Buffer.from('v11'), Buffer.from('not-openable-bytes')]), '/', chromeTime(FUTURE), 1, 1, 1, 1)
    // No name at all.
    insert.run(6, '.example.com', '', '', chromeEncrypt('chrome-d', '.example.com', true), '/', chromeTime(FUTURE), 1, 1, 1, 1)
    db.close()
  }
}

// ─── Safari fixture ───

function safariStorePath(): string {
  return join(
    fakeHome, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies', 'Cookies.binarycookies',
  )
}

interface SafariFixtureCookie {
  domain: string
  name: string
  path: string
  value: string
  flags: number
  /** Unix seconds. */
  expiresAt: number
}

/** One `binarycookies` record, written exactly as Safari lays one out. Writing
 *  the format rather than checking in a blob is what makes the parser's own
 *  bounds arithmetic testable. */
function safariRecord(cookie: SafariFixtureCookie): Buffer {
  const parts = [cookie.domain, cookie.name, cookie.path, cookie.value].map((text) =>
    Buffer.from(`${text}\0`, 'utf8'))
  const offsets: number[] = []
  let cursor = 56
  for (const part of parts) {
    offsets.push(cursor)
    cursor += part.length
  }
  const record = Buffer.alloc(cursor)
  record.writeUInt32LE(cursor, 0)
  record.writeUInt32LE(cookie.flags, 8)
  for (const [index, offset] of offsets.entries()) record.writeUInt32LE(offset, 16 + index * 4)
  // Apple's absolute time: seconds since 2001-01-01.
  record.writeDoubleLE(cookie.expiresAt - 978_307_200, 40)
  record.writeDoubleLE(NOW_SECONDS - 978_307_200, 48)
  for (const [index, part] of parts.entries()) part.copy(record, offsets[index]!)
  return record
}

function safariFile(cookies: SafariFixtureCookie[]): Buffer {
  const records = cookies.map(safariRecord)
  const headerSize = 4 + 4 + records.length * 4 + 4
  const page = Buffer.alloc(headerSize + records.reduce((total, record) => total + record.length, 0))
  page.writeUInt32BE(0x0000_0100, 0)
  page.writeUInt32LE(records.length, 4)
  let cursor = headerSize
  for (const [index, record] of records.entries()) {
    page.writeUInt32LE(cursor, 8 + index * 4)
    record.copy(page, cursor)
    cursor += record.length
  }
  const head = Buffer.alloc(8 + 4)
  head.write('cook', 0, 'ascii')
  head.writeUInt32BE(1, 4)
  head.writeUInt32BE(page.length, 8)
  return Buffer.concat([head, page, Buffer.alloc(8)])
}

function seedSafari(): void {
  const path = safariStorePath()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, safariFile([
    // Eligible: secure + httpOnly, and a plain one.
    { domain: '.example.com', name: 'sid', path: '/', value: 'safari-a', flags: 0x5, expiresAt: FUTURE },
    { domain: 'app.example.com', name: 'theme', path: '/app', value: 'sepia', flags: 0x0, expiresAt: FUTURE },
    // Expired.
    { domain: '.example.com', name: 'stale', path: '/', value: 'safari-b', flags: 0x1, expiresAt: NOW_SECONDS - 10 },
    // No name to address it by.
    { domain: '.example.com', name: '', path: '/', value: 'safari-c', flags: 0x0, expiresAt: FUTURE },
  ]))
}

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  sources = await import('@solus/server/browser/cookie-sources')
  chromium = await import('@solus/server/browser/chromium-cookies')
  safari = await import('@solus/server/browser/safari-cookies')
  profiles = await import('@solus/server/browser/browser-profiles')
  surface = await import('@solus/server/browser/surface-driver')
  db = await import('@solus/server/db')
  seedFirefox()
  seedChrome()
  if (ON_MACOS) seedSafari()
})

afterEach(() => {
  surface.setBrowserProfileHost(null)
  db.closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('what the host offers to import from', () => {
  test('every installed browser is offered, each named by its own profile', () => {
    // WHY: the directory names are `p7q2xk.default-release` and `Profile 1`,
    // which tell a user with several profiles nothing. Each browser records the
    // names their owner chose, and those are what a person picks by.
    const scan = sources.discoverCookieSources()

    expect(scan.supported).toBe(true)
    const byId = new Map(scan.sources.map((source) => [source.id, source]))
    expect(byId.get(FIREFOX_ID)).toMatchObject({ browser: 'firefox', label: 'Firefox — Work' })
    expect(byId.get(CHROME_ID)).toMatchObject({ browser: 'chrome', label: 'Chrome — Personal' })
    expect(byId.get('chrome:Profile 1')?.label).toBe('Chrome — Work')
    if (ON_MACOS) expect(byId.get(SAFARI_ID)).toMatchObject({ browser: 'safari', label: 'Safari' })
  })

  test('a scan never unlocks anything, so opening the list cannot prompt', () => {
    // WHY: Chrome's key is in the OS keychain. Counting by decrypting would make
    // *looking at the list* show a system password dialog, which is the one thing
    // a person browsing their options has not consented to.
    const scan = sources.discoverCookieSources()
    const chrome = scan.sources.find((source) => source.id === CHROME_ID)

    // Three of the six rows pass the metadata filters. The sealed one is among
    // them: that it cannot be opened is only discoverable once a key is applied,
    // which is exactly what a scan must not do.
    expect(chrome?.importable).toBe(3)
    expect(chrome?.unlockPrompt).toBe(
      ON_MACOS ? 'macOS will ask once for permission to read Chrome’s key from your keychain.' : undefined,
    )
  })

  test('Firefox needs no unlock at all, and says so by carrying no prompt', () => {
    const scan = sources.discoverCookieSources()
    const firefox = scan.sources.find((source) => source.id === FIREFOX_ID)

    expect(firefox?.importable).toBe(2)
    expect(firefox?.unlockPrompt).toBeUndefined()
    expect(firefox?.unavailable).toBeUndefined()
  })

  test('a client cannot name a path, only a source the host found', () => {
    // WHY: accepting a path would make this "read any file on the host", which is
    // not what an import is.
    expect(() => sources.resolveCookieSource('../../etc/passwd')).toThrow('No browser profile')
    expect(() => sources.resolveCookieSource('firefox:not-a-profile')).toThrow('No browser profile')
    expect(() => sources.resolveCookieSource('chrome:Default/../../etc')).toThrow('No browser profile')
  })

  test('ids are namespaced by browser, so two browsers cannot collide', () => {
    const scan = sources.discoverCookieSources()
    const ids = scan.sources.map((source) => source.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^(firefox|chrome|safari):/)
  })
})

describe('Firefox: cookies in the clear', () => {
  test('every rejection is counted under a reason a user can act on', async () => {
    const read = await sources.readCookieSource(sources.resolveCookieSource(FIREFOX_ID))

    expect(read.read).toBe(8)
    expect(read.cookies).toHaveLength(2)
    expect(read.skipped).toEqual({
      expired: 1,
      partitioned: 1,
      container: 2,
      encrypted: 0,
      unsupported: 2,
    })
  })

  test('an eligible cookie keeps the attributes that decide where it applies', async () => {
    // WHY: a domain cookie copied as host-only, or a secure cookie copied without
    // its flag, is a cookie that silently never matches a request.
    const read = await sources.readCookieSource(sources.resolveCookieSource(FIREFOX_ID))
    const [domainCookie, hostOnly] = read.cookies

    expect(domainCookie).toEqual({
      name: 'sid',
      value: 'secret-a',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expiresAt: FUTURE,
    })
    expect(hostOnly).toMatchObject({ domain: 'app.example.com', secure: false, sameSite: 'strict' })
  })
})

describe('Chrome: cookies behind a key', () => {
  test('a value encrypted the way Chrome encrypts one comes back in the clear', () => {
    const encrypted = chromeEncrypt('hello', '.example.com', true)
    expect(chromium.decryptChromiumValue(encrypted, CHROME_KEY, '.example.com')).toBe('hello')
  })

  test('the host hash Chrome prefixes is verified and stripped, never pasted on', () => {
    // WHY: since M118 the plaintext begins with SHA-256 of the cookie's own host.
    // A cookie carrying 32 bytes of hash in front of its session id is one that
    // fails against every request while looking imported.
    const encrypted = chromeEncrypt('token', '.example.com', true)
    const opened = chromium.decryptChromiumValue(encrypted, CHROME_KEY, '.example.com')

    expect(opened).toBe('token')
    expect(opened).not.toContain(createHash('sha256').update('.example.com').digest('hex'))
  })

  test('a value with no host prefix is returned whole', () => {
    // WHY: older profiles have no prefix, and stripping 32 bytes from one would
    // silently truncate every value.
    const encrypted = chromeEncrypt('short', 'app.example.com', false)
    expect(chromium.decryptChromiumValue(encrypted, CHROME_KEY, 'app.example.com')).toBe('short')
  })

  test('a value this key cannot open is one skipped cookie, not a failed import', () => {
    // WHY: a Linux keyring or a Windows app-bound envelope is Chrome's doing, not
    // a fault here. Throwing would lose the other nine hundred cookies.
    const sealed = Buffer.concat([Buffer.from('v11'), Buffer.from('not-openable-bytes')])
    expect(chromium.decryptChromiumValue(sealed, CHROME_KEY, '.example.com')).toBeNull()
    expect(chromium.decryptChromiumValue(Buffer.from('plain'), CHROME_KEY, '.example.com')).toBeNull()
  })

  test('an undecryptable row is counted as encrypted, under its own name', () => {
    // WHY: filing it under "unsupported" would suggest the cookie was the
    // problem, when what failed was this host's access to the key.
    const read = chromium.readChromiumCookies(sources.resolveCookieSource(CHROME_ID), CHROME_KEY)

    expect(read.read).toBe(6)
    expect(read.cookies.map((cookie) => cookie.name)).toEqual(['sid', 'theme'])
    expect(read.skipped).toEqual({
      expired: 1,
      partitioned: 1,
      container: 0,
      encrypted: 1,
      unsupported: 1,
    })
  })

  test('Chromium’s own timestamps and flags survive the copy', () => {
    // WHY: Chrome counts microseconds from 1601. Copying that number as seconds
    // would date every cookie to the seventeenth millennium and never expire one.
    const read = chromium.readChromiumCookies(sources.resolveCookieSource(CHROME_ID), CHROME_KEY)
    const [session, sessionless] = read.cookies

    expect(session).toEqual({
      name: 'sid',
      value: 'chrome-a',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expiresAt: FUTURE,
    })
    // `is_persistent` zero is a session cookie, and it stays one.
    expect(sessionless).toMatchObject({ name: 'theme', value: 'light', sameSite: 'strict' })
    expect(sessionless?.expiresAt).toBeUndefined()
  })

  test('the count and the import agree except on what a key refuses', () => {
    // WHY: those are the only two numbers a user sees, and the one honest reason
    // they can differ is a value the host could not open.
    const source = sources.resolveCookieSource(CHROME_ID)
    const counted = chromium.countChromiumCookies(source)
    const read = chromium.readChromiumCookies(source, CHROME_KEY)

    expect(counted).toBe(read.cookies.length + read.skipped.encrypted)
  })
})

describe('Safari: cookies behind macOS itself', () => {
  test.skipIf(!ON_MACOS)('the binarycookies format is parsed, not shelled out to', () => {
    const read = safari.readSafariCookies(sources.resolveCookieSource(SAFARI_ID))

    expect(read.read).toBe(4)
    expect(read.cookies).toEqual([
      {
        name: 'sid',
        value: 'safari-a',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expiresAt: FUTURE,
      },
      {
        name: 'theme',
        value: 'sepia',
        domain: 'app.example.com',
        path: '/app',
        secure: false,
        httpOnly: false,
        sameSite: 'lax',
        expiresAt: FUTURE,
      },
    ])
    expect(read.skipped).toMatchObject({ expired: 1, unsupported: 1 })
  })

  test.skipIf(!ON_MACOS)('a file that is not one of these yields nothing rather than guessing', () => {
    // WHY: every offset in the format comes from the file itself. A truncated or
    // foreign file must produce no cookies rather than reads past its own end.
    const path = join(fakeHome, 'broken.binarycookies')
    writeFileSync(path, Buffer.from('not a cookie file at all'))

    const read = safari.readSafariCookies({
      id: 'safari:broken', browser: 'safari', label: 'Broken', storePath: path,
    })
    expect(read.read).toBe(0)
    expect(read.cookies).toEqual([])
  })

  test.skipIf(!ON_MACOS)('a page whose offsets run past its own end is dropped, not read past', () => {
    const path = join(fakeHome, 'truncated.binarycookies')
    const whole = safariFile([
      { domain: '.example.com', name: 'sid', path: '/', value: 'x', flags: 0, expiresAt: FUTURE },
    ])
    writeFileSync(path, whole.subarray(0, whole.length - 20))

    const read = safari.readSafariCookies({
      id: 'safari:truncated', browser: 'safari', label: 'Truncated', storePath: path,
    })
    expect(read.cookies).toEqual([])
  })

  test('Safari is offered only where it exists', () => {
    // WHY: a Linux or Windows host has no Safari, and listing one would be an
    // offer that can never be taken.
    const listed = safari.safariProfiles()
    expect(listed.length).toBe(ON_MACOS ? 1 : 0)
  })
})

describe('the source store is never opened, and no copy outlives the read', () => {
  test('reading leaves the user’s own file exactly as it was', async () => {
    // WHY: browsers write these continuously in WAL mode. A reader attached to
    // the live file either blocks the user's browser or sees a half-committed
    // transaction — so the store is copied, and the copy is what is opened.
    const cookiesPath = join(firefoxRoot(), 'Profiles', FIREFOX_DIR, 'cookies.sqlite')
    const before = statSync(cookiesPath)

    await sources.readCookieSource(sources.resolveCookieSource(FIREFOX_ID))
    chromium.readChromiumCookies(sources.resolveCookieSource(CHROME_ID), CHROME_KEY)

    const after = statSync(cookiesPath)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    // No journal was created beside it, which is what opening it would have done.
    expect(readdirSync(join(firefoxRoot(), 'Profiles', FIREFOX_DIR)).sort()).toEqual(['cookies.sqlite'])
    // And nothing holding plain-text cookies was left in the temp directory.
    const leftovers = readdirSync(realOs.tmpdir()).filter((entry) => entry.startsWith('solus-cookie-read-'))
    expect(leftovers).toEqual([])
  })
})

describe('importing into a Solus profile', () => {
  function installProfileHost() {
    const received: { partition: string; names: string[] }[] = []
    surface.setBrowserProfileHost({
      clearProfile: async () => {},
      importCookies: async (partition, cookies) => {
        received.push({ partition, names: cookies.map((cookie) => cookie.name) })
        return { imported: cookies.length, failed: 0 }
      },
    })
    return received
  }

  test('the request must carry the user’s consent, in the request itself', async () => {
    // WHY: this is the moment an agent gains the ability to act as the user's
    // signed-in self. A call that could reach that state without the user saying
    // so would be the wrong shape whatever UI sat in front of it.
    installProfileHost()
    await expect(runImport({ consent: false })).rejects.toThrow('explicit consent')
  })

  test('the destination must be a profile this project actually owns', async () => {
    installProfileHost()
    await expect(runImport({ profileId: 'ghost' })).rejects.toThrow('No browser profile ghost')
  })

  test('cookies land in the destination profile’s own jar', async () => {
    const received = installProfileHost()
    profiles.createBrowserProfile(PROJECT, 'Admin')

    const result = await runImport({ profileId: 'admin' })

    const { browserProfilePartition } = await import('@solus/contracts/browser-types')
    expect(received).toEqual([
      { partition: browserProfilePartition(PROJECT, 'admin'), names: ['sid', 'theme'] },
    ])
    expect(result.imported).toBe(2)
  })

  test('what comes back is counts — never a cookie, a value, or a site', async () => {
    // WHY: the result crosses RPC to a renderer that may be on another device.
    // A domain is browsing history, and none of it is the client's business.
    installProfileHost()

    const result = await runImport({})

    expect(Object.keys(result).sort()).toEqual(['failed', 'imported', 'profileId', 'read', 'skipped'])
    expect(JSON.stringify(result)).not.toContain('secret-')
    expect(JSON.stringify(result)).not.toContain('example.com')
    expect(result).toMatchObject({ read: 8, imported: 2, failed: 0 })
  })

  test('a host with no profiles says so rather than reporting a silent success', async () => {
    // WHY: the same RPC is reachable from a phone talking to a server that cannot
    // hold a cookie jar at all.
    surface.setBrowserProfileHost(null)
    await expect(runImport({})).rejects.toThrow('holds no browser profiles')
  })

  /** One import, with the parts a test wants to vary. Firefox by default: it is
   *  the source that needs no key, so no test here can reach a keychain. */
  function runImport(overrides: { consent?: boolean; profileId?: string; sourceId?: string }) {
    return profiles.importBrowserCookies({
      sourceId: overrides.sourceId ?? FIREFOX_ID,
      projectRoot: PROJECT,
      profileId: overrides.profileId ?? 'default',
      // SAFETY: the contract's literal `true` is the point of the flag; a test
      // for the refusal has to be able to send something else.
      consent: (overrides.consent ?? true) as true,
    })
  }
})
