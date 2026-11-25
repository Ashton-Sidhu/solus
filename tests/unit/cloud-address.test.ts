import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountState } from '@solus/contracts/account-types'
import { DEFAULT_CLOUD_ORIGIN, parseCloudAddress, resolveCloudAddress } from '@solus/contracts/cloud-address'
import { OAuthSession, type BrowserAuthorizer, type StoredGrant, type TokenStore } from '@solus/client-core/oauth-session'
import { AccountSession } from '@solus/desktop-main/account/account-session'
import { AccountStore } from '@solus/desktop-main/account/account-store'
import { DeviceCloudAddress } from '@solus/desktop-main/account/cloud-address'
import { cloudAddressRow } from '../../packages/workspace-ui/src/components/settings/lib/cloud-address-row'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

// docs/solus-cloud-address.md. WHY: a person whose organization hosts its own Solus
// Cloud signs in there, not at app.solus.sh. The address decides where the refresh
// token goes, so it is an https origin, it changes only while signed out, and a
// sign-in at one address never sends its tokens to another.

const SELF_HOSTED = 'https://solus.acme.example'

/** Two Solus Clouds behind one `fetch`: each request goes to the plane of its origin. */
function twoClouds() {
  const hosted = fakeAccountPlane()
  const selfHosted = fakeAccountPlane({ issuer: SELF_HOSTED })
  const requests: Array<{ origin: string; path: string; body: string; authorization: string | null }> = []
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    requests.push({ origin: url.origin, path: url.pathname, body: typeof init?.body === 'string' ? init.body : '', authorization: new Headers(init?.headers).get('authorization') })
    if (url.origin === ISSUER) return hosted.fetch(input, init)
    if (url.origin === SELF_HOSTED) return selfHosted.fetch(input, init)
    throw new TypeError('fetch failed')
  }
  const authorizer: BrowserAuthorizer = {
    async start() {
      return {
        redirectUri: 'http://127.0.0.1:50000/callback',
        complete: async (authorizeUrl: URL) => (authorizeUrl.origin === SELF_HOSTED ? selfHosted : hosted).approve(authorizeUrl),
        cancel() {},
      }
    },
  }
  return { hosted, selfHosted, requests, fetch: fetchImpl, authorizer }
}

function memoryStore() {
  let grant: StoredGrant | null = null
  const store: TokenStore = { load: () => grant, save: (next) => { grant = next }, clear: () => { grant = null } }
  return { store, current: () => grant }
}

describe('a Solus Cloud address', () => {
  test('is an https origin; a typed host name is read as https', () => {
    expect(parseCloudAddress(' https://solus.acme.example/ ')).toEqual({ ok: true, origin: SELF_HOSTED })
    expect(parseCloudAddress('solus.acme.example')).toEqual({ ok: true, origin: SELF_HOSTED })
    expect(parseCloudAddress('https://solus.acme.example:8443')).toEqual({ ok: true, origin: 'https://solus.acme.example:8443' })
  })

  test('uses http only for this device itself', () => {
    expect(parseCloudAddress('http://localhost:8787')).toEqual({ ok: true, origin: 'http://localhost:8787' })
    expect(parseCloudAddress('http://127.0.0.1:8787')).toEqual({ ok: true, origin: 'http://127.0.0.1:8787' })
    expect(parseCloudAddress('http://[::1]:8787')).toEqual({ ok: true, origin: 'http://[::1]:8787' })
    // WHY: the sign-in and the refresh token cross the network in the clear over http.
    expect(parseCloudAddress('http://solus.acme.example')).toEqual({ ok: false, refusal: 'not-https' })
    expect(parseCloudAddress('http://192.168.1.20:8787')).toEqual({ ok: false, refusal: 'not-https' })
    expect(parseCloudAddress('ftp://solus.acme.example')).toEqual({ ok: false, refusal: 'not-https' })
  })

  test('has no path, query, fragment, or credentials, and says which one it refused', () => {
    expect(parseCloudAddress('https://solus.acme.example/console')).toEqual({ ok: false, refusal: 'has-path' })
    expect(parseCloudAddress('https://solus.acme.example/?next=1')).toEqual({ ok: false, refusal: 'has-path' })
    expect(parseCloudAddress('https://solus.acme.example/#top')).toEqual({ ok: false, refusal: 'has-path' })
    expect(parseCloudAddress('https://ada:secret@solus.acme.example')).toEqual({ ok: false, refusal: 'has-credentials' })
    expect(parseCloudAddress('   ')).toEqual({ ok: false, refusal: 'empty' })
    expect(parseCloudAddress('https://')).toEqual({ ok: false, refusal: 'not-a-url' })
    expect(parseCloudAddress('not an address')).toEqual({ ok: false, refusal: 'not-a-url' })
  })

  test('comes from the environment before the setting, and from the setting before the hosted default', () => {
    expect(resolveCloudAddress({})).toEqual({ origin: DEFAULT_CLOUD_ORIGIN, source: 'default' })
    expect(resolveCloudAddress({ setting: SELF_HOSTED })).toEqual({ origin: SELF_HOSTED, source: 'setting' })
    expect(resolveCloudAddress({ environment: 'http://localhost:8787', setting: SELF_HOSTED })).toEqual({ origin: 'http://localhost:8787', source: 'environment' })
    expect(resolveCloudAddress({ environment: '  ', setting: SELF_HOSTED })).toEqual({ origin: SELF_HOSTED, source: 'setting' })
    // A stored value that is not an address must not stop the app: the hosted address is used.
    expect(resolveCloudAddress({ setting: 'http://solus.acme.example' })).toEqual({ origin: DEFAULT_CLOUD_ORIGIN, source: 'default' })
    // The environment is a developer's own value: a wrong one is said at once.
    expect(() => resolveCloudAddress({ environment: 'http://solus.acme.example' })).toThrow('SOLUS_CLOUD_URL')
  })
})

describe('one sign-in and its Solus Cloud address', () => {
  test('a sign-in after a change of address talks only to the new address', async () => {
    const clouds = twoClouds()
    const memory = memoryStore()
    const session = new OAuthSession({ cloudOrigin: ISSUER, clientId: clouds.hosted.clientId, store: memory.store, authorizer: clouds.authorizer, fetch: clouds.fetch, now: clouds.hosted.now })
    expect(session.useCloudOrigin(SELF_HOSTED)).toBe(true)
    expect(await session.signIn()).toBe('approved')
    expect(session.state()).toMatchObject({ kind: 'signed-in', consoleUrl: SELF_HOSTED })
    expect(await session.accessToken({ kind: 'host', hostId: 'host-1' })).toBeTruthy()
    expect(clouds.requests.map((request) => request.path)).toContain('/.well-known/openid-configuration')
    expect(clouds.requests.every((request) => request.origin === SELF_HOSTED)).toBe(true)
  })

  test('the address does not change while a sign-in is held', async () => {
    const clouds = twoClouds()
    const memory = memoryStore()
    const session = new OAuthSession({ cloudOrigin: ISSUER, clientId: clouds.hosted.clientId, store: memory.store, authorizer: clouds.authorizer, fetch: clouds.fetch, now: clouds.hosted.now })
    await session.signIn()
    // WHY: the held refresh token belongs to the first address; a move would send it to the second.
    expect(session.useCloudOrigin(SELF_HOSTED)).toBe(false)
    expect(session.cloudOrigin).toBe(ISSUER)
    clouds.hosted.advance(600_000)
    await session.accessToken({ kind: 'account' })
    expect(clouds.requests.some((request) => request.origin === SELF_HOSTED)).toBe(false)
    await session.signOut()
    expect(session.useCloudOrigin(SELF_HOSTED)).toBe(true)
  })

  test('a sign-in kept for one address is not used at another address', async () => {
    const clouds = twoClouds()
    const memory = memoryStore()
    const first = new OAuthSession({ cloudOrigin: ISSUER, clientId: clouds.hosted.clientId, store: memory.store, authorizer: clouds.authorizer, fetch: clouds.fetch, now: clouds.hosted.now })
    await first.signIn()
    const kept = memory.current()!
    clouds.requests.length = 0

    // The next start names another address (the environment changed, or the keychain answered late).
    const second = new OAuthSession({ cloudOrigin: SELF_HOSTED, clientId: clouds.hosted.clientId, store: memory.store, authorizer: clouds.authorizer, fetch: clouds.fetch, now: clouds.hosted.now })
    expect(second.state()).toEqual({ kind: 'signed-out' })
    second.reload()
    expect(second.state()).toEqual({ kind: 'signed-out' })
    expect(await second.accessToken({ kind: 'account' })).toBeNull()
    expect(await second.accessToken({ kind: 'host', hostId: 'host-1' })).toBeNull()
    // Nothing of the kept sign-in left this device: no refresh, no exchange, no bearer.
    expect(clouds.requests).toEqual([])
    expect(memory.current()).toEqual(kept)

    // A sign-in at the new address starts clean and replaces the kept one.
    expect(await second.signIn()).toBe('approved')
    expect(second.state()).toMatchObject({ kind: 'signed-in', consoleUrl: SELF_HOSTED })
    expect(memory.current()!.idToken).not.toBe(kept.idToken)
    expect(clouds.requests.every((request) => request.origin === SELF_HOSTED)).toBe(true)
    // The kept sign-in is now the new address's, so the first address reads as signed out too.
    expect(new OAuthSession({ cloudOrigin: ISSUER, clientId: clouds.hosted.clientId, store: memory.store, fetch: clouds.fetch, now: clouds.hosted.now }).state()).toEqual({ kind: 'signed-out' })
  })

  test('an address that is not a Solus Cloud ends the sign-in with an error, not a wait', async () => {
    const clouds = twoClouds()
    const memory = memoryStore()
    const session = new OAuthSession({ cloudOrigin: 'https://wrong.example', clientId: clouds.hosted.clientId, store: memory.store, authorizer: clouds.authorizer, fetch: clouds.fetch, now: clouds.hosted.now })
    expect(await session.signIn()).toBe('error')
    const failed: AccountState = { kind: 'invalid', reason: 'unreachable' }
    expect(session.state()).toEqual(failed)
    expect(cloudAddressRow(failed, { origin: 'https://wrong.example', source: 'setting' })).toMatchObject({
      isEditable: true,
      signInError: 'Could not reach Solus Cloud at wrong.example. Check the address and your connection, then try again.',
    })
    // The person corrects the address: the error leaves and the next sign-in works.
    expect(session.useCloudOrigin(SELF_HOSTED)).toBe(true)
    expect(session.state()).toEqual({ kind: 'signed-out' })
    expect(await session.signIn()).toBe('approved')
  })
})

describe('the Solus Cloud address of this computer', () => {
  let directory: string
  let path: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'solus-cloud-address-'))
    path = join(directory, 'cloud-address.json')
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  function desktop(environment?: string) {
    const clouds = twoClouds()
    const address = new DeviceCloudAddress(path, environment)
    const store = new AccountStore(join(directory, 'account.bin'), {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    })
    const states: AccountState[] = []
    const session = new AccountSession({ cloudOrigin: address.current().origin, store, authorizer: clouds.authorizer, fetch: clouds.fetch as typeof fetch, now: clouds.hosted.now, onStateChange: (state) => states.push(state) })
    return { clouds, address, session, states }
  }

  test('a computer that never chose signs in to the hosted Solus Cloud', () => {
    expect(new DeviceCloudAddress(path, undefined).current()).toEqual({ origin: DEFAULT_CLOUD_ORIGIN, source: 'default' })
  })

  test('the choice survives a relaunch, and the hosted address comes back on request', () => {
    const w = desktop()
    expect(w.address.change('solus.acme.example', w.session)).toEqual({ ok: true, address: { origin: SELF_HOSTED, source: 'setting' } })
    expect(new DeviceCloudAddress(path, undefined).current()).toEqual({ origin: SELF_HOSTED, source: 'setting' })
    expect(w.address.change(null, w.session)).toEqual({ ok: true, address: { origin: DEFAULT_CLOUD_ORIGIN, source: 'default' } })
    expect(existsSync(path)).toBe(false)
    expect(new DeviceCloudAddress(path, undefined).current().source).toBe('default')
  })

  test('the account calls of the app go to the chosen address', async () => {
    const w = desktop()
    w.address.change(SELF_HOSTED, w.session)
    expect(await w.session.signIn()).toBe('approved')
    expect(w.session.current()).toMatchObject({ kind: 'signed-in', consoleUrl: SELF_HOSTED })
    await w.session.cloudRequest('/v1/hosts')
    const directoryRead = w.clouds.requests.find((request) => request.path === '/v1/hosts')
    expect(directoryRead?.origin).toBe(SELF_HOSTED)
    expect(directoryRead?.authorization).toBeTruthy()
    expect(w.clouds.requests.every((request) => request.origin === SELF_HOSTED)).toBe(true)
  })

  test('a change while signed in is refused and nothing is kept', async () => {
    const w = desktop()
    w.address.change(ISSUER, w.session)
    await w.session.signIn()
    expect(w.address.change(SELF_HOSTED, w.session)).toEqual({ ok: false, refusal: 'signed-in' })
    expect(w.address.current().origin).toBe(ISSUER)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ origin: ISSUER })
    expect(w.session.cloudOrigin).toBe(ISSUER)
    expect(cloudAddressRow(w.session.current(), w.address.current())).toEqual({ isEditable: false, lockNote: 'Sign out to change the address.', signInError: null })
    await w.session.signOut()
    expect(w.address.change(SELF_HOSTED, w.session).ok).toBe(true)
  })

  test('an address that is refused changes nothing and says why', () => {
    const w = desktop()
    expect(w.address.change('http://solus.acme.example', w.session)).toEqual({ ok: false, refusal: 'not-https' })
    expect(w.address.change('https://solus.acme.example/console', w.session)).toEqual({ ok: false, refusal: 'has-path' })
    expect(w.session.cloudOrigin).toBe(DEFAULT_CLOUD_ORIGIN)
    expect(existsSync(path)).toBe(false)
  })

  test('SOLUS_CLOUD_URL wins over the setting, and then the setting cannot change', () => {
    writeFileSync(path, JSON.stringify({ origin: SELF_HOSTED }))
    const w = desktop('http://localhost:8787')
    expect(w.address.current()).toEqual({ origin: 'http://localhost:8787', source: 'environment' })
    expect(w.session.cloudOrigin).toBe('http://localhost:8787')
    expect(w.address.change(ISSUER, w.session)).toEqual({ ok: false, refusal: 'environment' })
    expect(w.session.cloudOrigin).toBe('http://localhost:8787')
    // The person's own choice is kept for the next start without the variable.
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ origin: SELF_HOSTED })
    expect(cloudAddressRow({ kind: 'signed-out' }, w.address.current())).toMatchObject({ isEditable: false, lockNote: expect.stringContaining('SOLUS_CLOUD_URL') })
  })

  test('a damaged file means the hosted address', () => {
    writeFileSync(path, '{ not json')
    expect(new DeviceCloudAddress(path, undefined).current()).toEqual({ origin: DEFAULT_CLOUD_ORIGIN, source: 'default' })
    writeFileSync(path, JSON.stringify({ origin: 'http://solus.acme.example/console' }))
    expect(new DeviceCloudAddress(path, undefined).current()).toEqual({ origin: DEFAULT_CLOUD_ORIGIN, source: 'default' })
  })

  test('a choice that this computer cannot keep is not applied', () => {
    const w = desktop()
    const unwritable = new DeviceCloudAddress(join(directory, 'missing-folder', 'cloud-address.json'), undefined)
    expect(unwritable.change(SELF_HOSTED, w.session)).toEqual({ ok: false, refusal: 'not-saved' })
    // WHY: a sign-in at an address that the next launch forgets would leave a sign-in the app cannot read.
    expect(w.session.cloudOrigin).toBe(DEFAULT_CLOUD_ORIGIN)
    expect(unwritable.current().origin).toBe(DEFAULT_CLOUD_ORIGIN)
  })

  test('the row is a field only while signed out', () => {
    const address = { origin: SELF_HOSTED, source: 'setting' as const }
    expect(cloudAddressRow({ kind: 'signed-out' }, address)).toEqual({ isEditable: true, lockNote: null, signInError: null })
    expect(cloudAddressRow({ kind: 'signing-in', authorizeUrl: `${SELF_HOSTED}/authorize` }, address).isEditable).toBe(false)
    expect(cloudAddressRow({ kind: 'invalid', reason: 'revoked' }, address)).toEqual({ isEditable: true, lockNote: null, signInError: null })
  })
})
