import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LocalOwnerToken } from '@solus/desktop-main/local-owner-token'

// docs/adr/0001-standard-authentication.md stage 6: the desktop window's credential for
// its own host is a local-owner token that carries no account. It must never be kept
// in plaintext (the file of earlier versions is removed), it keeps one device id
// across restarts while the keychain works, and with no keychain it lives in memory only.

const DAY = 24 * 60 * 60 * 1000
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function world(options: { keychain?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'solus-local-owner-token-'))
  directories.push(directory)
  let now = 1_000 * DAY
  let issued = 0
  /** The host: a token is `<device>@<issuedAt>`, and it accepts only the ones it issued. */
  const accepted = new Set<string>()
  const sign = (device: string) => {
    const token = `${device}@${now}`
    accepted.add(token)
    return token
  }
  const make = () => new LocalOwnerToken({
    file: join(directory, 'local-session-token.bin'),
    legacyFile: join(directory, 'local-session-token.json'),
    cipher: {
      isEncryptionAvailable: () => options.keychain ?? true,
      encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
      decryptString: (value) => Buffer.from(value.toString().slice('sealed:'.length), 'base64').toString(),
    },
    issue: () => sign(`device-${++issued}`),
    issuedAt: (token) => accepted.has(token) ? Number(token.split('@')[1]) : null,
    refresh: (token) => accepted.has(token) ? sign(token.split('@')[0]!) : null,
    now: () => now,
  })
  return { directory, make, accepted, advance: (ms: number) => { now += ms } }
}

describe('the desktop window’s local-owner token', () => {
  test('it is kept sealed, and a restart reuses it with the same device', () => {
    const w = world()
    const first = w.make().current()
    const stored = readFileSync(join(w.directory, 'local-session-token.bin'), 'utf8')
    expect(stored).not.toContain(first)
    expect(w.make().current()).toBe(first)
  })

  test('the plaintext file of earlier versions is removed and not used', () => {
    const w = world()
    const legacy = join(w.directory, 'local-session-token.json')
    w.accepted.add('device-old@1000')
    writeFileSync(legacy, JSON.stringify({ token: 'device-old@1000' }))
    const token = w.make().current()
    expect(existsSync(legacy)).toBe(false)
    expect(token).toStartWith('device-1@')
  })

  test('an old token is signed again for the same device; one the host no longer accepts is replaced', () => {
    const w = world()
    const tokens = w.make()
    const first = tokens.current()
    w.advance(8 * DAY)
    const refreshed = tokens.current()
    expect(refreshed).not.toBe(first)
    expect(refreshed).toStartWith('device-1@')
    w.accepted.clear()
    expect(w.make().current()).toStartWith('device-2@')
  })

  test('with no keychain the token lives in memory only, never on disk', () => {
    const w = world({ keychain: false })
    const tokens = w.make()
    const token = tokens.current()
    expect(tokens.current()).toBe(token)
    expect(existsSync(join(w.directory, 'local-session-token.bin'))).toBe(false)
  })
})
