import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountState } from '@solus/contracts/account-types'
import { ACCOUNT_AUDIENCE, hostAudience } from '@solus/contracts/uplink'
import type { BrowserAuthorizer } from '@solus/client-core/oauth-session'
import { AccountSession } from '@solus/desktop-main/account/account-session'
import { AccountStore } from '@solus/desktop-main/account/account-store'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

// The desktop's account sign-in (ADR 0001 §3.3): one OAuthSession in main serves every
// window and the local host, the keychain race at boot does not read as signed out,
// and calls to the website carry an account-plane access token.

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function world(options: { keychainAtStart?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'solus-account-session-'))
  directories.push(directory)
  let keychain = options.keychainAtStart ?? true
  const store = new AccountStore(join(directory, 'account.bin'), {
    isEncryptionAvailable: () => keychain,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  })
  const plane = fakeAccountPlane()
  const authorizer: BrowserAuthorizer = {
    async start() {
      return { redirectUri: 'http://127.0.0.1:50001/callback', complete: async (url) => plane.approve(url), cancel() {} }
    },
  }
  const states: AccountState[] = []
  const make = () => new AccountSession({ cloudOrigin: ISSUER, store, authorizer, fetch: plane.fetch as typeof fetch, now: plane.now, onStateChange: (state) => states.push(state) })
  return { plane, store, states, make, setKeychain: (ready: boolean) => { keychain = ready } }
}

describe('desktop account session', () => {
  test('every window and the local host share one refresh for a host', async () => {
    const w = world()
    const session = w.make()
    expect(await session.signIn()).toBe('approved')
    const [owner, window] = await Promise.all([
      session.accessToken({ kind: 'host', hostId: 'host-1' }),
      session.accessToken({ kind: 'host', hostId: 'host-1' }),
    ])
    expect(owner).toBe(window)
    expect(owner).toContain(hostAudience('host-1'))
    expect(w.plane.calls.filter((call) => call.form.get('grant_type') === 'refresh_token')).toHaveLength(1)
  })

  test('a website call carries an access token for the account plane, never the refresh token', async () => {
    const w = world()
    const session = w.make()
    await session.signIn()
    const sent: Array<{ url: string; authorization: string | null }> = []
    const plane = w.plane.fetch
    const recording = new AccountSession({
      cloudOrigin: ISSUER, store: w.store, authorizer: { start: async () => { throw new Error('unused') } },
      fetch: (async (input: string | URL, init?: RequestInit) => {
        sent.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
        return plane(input, init)
      }) as typeof fetch,
      now: w.plane.now, onStateChange: () => {},
    })
    await recording.cloudRequest('/v1/hosts')
    const directory = sent.find((call) => call.url === `${ISSUER}/v1/hosts`)!
    expect(directory.authorization).toContain(ACCOUNT_AUDIENCE)
    expect(sent.some((call) => call.authorization?.includes('rt-'))).toBe(false)
  })

  test('a keychain that is not ready at boot reads as unavailable, then the stored sign-in once it is', async () => {
    const w = world()
    await w.make().signIn()
    // The next boot runs before Electron's keychain answers.
    w.setKeychain(false)
    const session = w.make()
    // Main's own reader (the local host's client, stage 6) hears the same change as the renderer.
    const heard: string[] = []
    session.onChange((state) => heard.push(state.kind))
    expect(session.current()).toEqual({ kind: 'unavailable', reason: 'encryption' })
    expect(await session.signIn()).toBe('error')
    w.setKeychain(true)
    session.reloadFromDisk()
    expect(session.current()).toMatchObject({ kind: 'signed-in', identity: { sub: 'user-1' } })
    expect(w.states.at(-1)?.kind).toBe('signed-in')
    expect(heard.at(-1)).toBe('signed-in')
  })

  test('verify reads the identity again; a revoked grant ends the sign-in', async () => {
    const w = world()
    const session = w.make()
    await session.signIn()
    w.plane.renameInUserinfo('Ada Lovelace')
    await session.verify('retry')
    expect(session.current()).toMatchObject({ kind: 'signed-in', identity: { name: 'Ada Lovelace' } })
    for (const token of w.plane.liveTokens()) await w.plane.fetch(`${ISSUER}/api/auth/oauth2/revoke`, { method: 'POST', body: new URLSearchParams({ token }).toString() })
    w.plane.advance(10 * 60_000)
    await session.verify('retry')
    expect(session.current()).toEqual({ kind: 'invalid', reason: 'revoked' })
    expect(w.store.load()).toBeNull()
  })

  test('sign-out revokes the grant and forgets it', async () => {
    const w = world()
    const session = w.make()
    await session.signIn()
    const heard: string[] = []
    session.onChange((state) => heard.push(state.kind))
    await session.signOut()
    expect(heard.at(-1)).toBe('signed-out')
    expect(w.plane.liveTokens()).toEqual([])
    expect(w.store.load()).toBeNull()
    expect(session.current().kind).toBe('signed-out')
    expect(await session.cloudRequest('/v1/hosts')).toBeNull()
  })
})
