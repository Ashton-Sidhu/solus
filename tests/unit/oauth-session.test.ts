import { describe, expect, test } from 'bun:test'
import { isLastingRefusal, OAuthSession, type BrowserAuthorizer, type StoredGrant, type TokenStore } from '@solus/client-core/oauth-session'
import { ACCOUNT_AUDIENCE, hostAudience } from '@solus/contracts/uplink'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

// One sign-in of one client (ADR 0001 §3.2). These tests pin the rules that keep a
// person signed in: the code flow with PKCE, one refresher per grant, the rotated
// refresh token saved before its access token is used, per-resource caching, and a
// sign-out that revokes the grant on the account plane.

function memoryStore(initial: StoredGrant | null = null) {
  let grant = initial
  const saves: string[] = []
  const store: TokenStore = {
    load: () => grant,
    save: (next) => { grant = next; saves.push(next.refreshToken) },
    clear: () => { grant = null },
  }
  return { store, saves, current: () => grant }
}

function approvingAuthorizer(plane: ReturnType<typeof fakeAccountPlane>, answer: 'approve' | 'deny' | 'close' = 'approve'): BrowserAuthorizer {
  return {
    async start() {
      return {
        redirectUri: 'http://127.0.0.1:50000/callback',
        complete: async (authorizeUrl: URL) => {
          if (answer === 'close') return null
          if (answer === 'deny') {
            const callback = new URL('http://127.0.0.1:50000/callback')
            callback.searchParams.set('error', 'access_denied')
            callback.searchParams.set('state', authorizeUrl.searchParams.get('state') ?? '')
            return callback
          }
          return plane.approve(authorizeUrl)
        },
        cancel() {},
      }
    },
  }
}

function world(options: { answer?: 'approve' | 'deny' | 'close'; gateRefresh?: () => Promise<void> } = {}) {
  const plane = fakeAccountPlane({ gateRefresh: options.gateRefresh })
  const memory = memoryStore()
  const session = new OAuthSession({
    cloudOrigin: ISSUER,
    clientId: plane.clientId,
    store: memory.store,
    authorizer: approvingAuthorizer(plane, options.answer),
    fetch: plane.fetch,
    now: plane.now,
  })
  return { plane, memory, session }
}

const HOST = { kind: 'host', hostId: 'host-1' } as const

describe('OAuthSession sign-in', () => {
  test('signs in with PKCE, state, and nonce, and reads the identity from the ID token', async () => {
    const w = world()
    const states: string[] = []
    w.session.onChange((state) => states.push(state.kind))
    expect(await w.session.signIn()).toBe('approved')
    const state = w.session.state()
    expect(state).toMatchObject({ kind: 'signed-in', identity: { sub: 'user-1', email: 'ada@example.test', emailVerified: true, name: 'Ada', picture: null }, consoleUrl: ISSUER, isStale: false })
    expect(states).toEqual(['signing-in', 'signed-in'])
    expect(w.memory.current()?.refreshToken).toBe('rt-2')
    const authorize = w.plane.calls.find((call) => call.path === '/api/auth/oauth2/token')!
    expect(authorize.form.get('code_verifier')).toBeTruthy()
    // Sign-in names no resource: each refresh names one (ADR §5).
    expect(authorize.form.get('resource')).toBeNull()
  })

  test('a denied or closed browser step leaves the client signed out', async () => {
    const denied = world({ answer: 'deny' })
    expect(await denied.session.signIn()).toBe('denied')
    expect(denied.session.state().kind).toBe('signed-out')
    const closed = world({ answer: 'close' })
    expect(await closed.session.signIn()).toBe('cancelled')
    expect(closed.session.state().kind).toBe('signed-out')
    expect(closed.memory.current()).toBeNull()
  })

  test('a callback with another state is refused, so a forged redirect cannot sign a client in', async () => {
    const w = world()
    const { authorizeUrl, pending } = await w.session.beginSignIn('http://127.0.0.1:50000/callback')
    const callback = w.plane.approve(authorizeUrl)
    callback.searchParams.set('state', 'forged')
    expect(await w.session.completeSignIn(callback, pending)).toBe('error')
    expect(w.session.state().kind).toBe('signed-out')
  })

  test('an ID token for another nonce is refused', async () => {
    const w = world()
    const { authorizeUrl, pending } = await w.session.beginSignIn('http://127.0.0.1:50000/callback')
    expect(await w.session.completeSignIn(w.plane.approve(authorizeUrl), { ...pending, nonce: 'other' })).toBe('error')
    expect(w.memory.current()).toBeNull()
  })

  test('an unreachable account plane reads as unreachable, not signed out', async () => {
    const w = world()
    w.plane.setDown(true)
    expect(await w.session.signIn()).toBe('error')
    expect(w.session.state()).toEqual({ kind: 'invalid', reason: 'unreachable' })
  })
})

describe('OAuthSession access tokens', () => {
  test('saves the rotated refresh token before it gives out the access token', async () => {
    const w = world()
    await w.session.signIn()
    const token = await w.session.accessToken(HOST)
    expect(token).toContain(hostAudience('host-1'))
    expect(w.memory.saves).toEqual(['rt-2', 'rt-4'])
    // The token used is the newest one; the one before it is spent.
    expect(w.plane.isLive('rt-4')).toBe(true)
    expect(w.plane.isLive('rt-2')).toBe(false)
  })

  test('keeps a token per resource until a minute before its end', async () => {
    const w = world()
    await w.session.signIn()
    const host = await w.session.accessToken(HOST)
    const account = await w.session.accessToken({ kind: 'account' })
    expect(account).toContain(ACCOUNT_AUDIENCE)
    expect(await w.session.accessToken(HOST)).toBe(host)
    w.plane.advance(239_000)
    expect(await w.session.accessToken(HOST)).toBe(host)
    w.plane.advance(2_000)
    expect(await w.session.accessToken(HOST)).not.toBe(host)
    expect(await w.session.accessToken(HOST, { fresh: true })).not.toBe(host)
  })

  test('runs one refresh at a time, so concurrent callers never replay a spent refresh token', async () => {
    const w = world()
    await w.session.signIn()
    const [first, second, api, account] = await Promise.all([
      w.session.accessToken(HOST),
      w.session.accessToken(HOST),
      w.session.accessToken({ kind: 'api' }),
      w.session.accessToken({ kind: 'account' }),
    ])
    expect(first).toBe(second)
    expect(api).toBeTruthy()
    expect(account).toBeTruthy()
    const refreshes = w.plane.calls.filter((call) => call.form.get('grant_type') === 'refresh_token')
    // One refresh per resource, each with the token the one before it gave.
    expect(refreshes.map((call) => call.form.get('refresh_token'))).toEqual(['rt-2', 'rt-4', 'rt-6'])
    expect(w.plane.liveTokens()).toEqual(['rt-8'])
    expect(w.session.state().kind).toBe('signed-in')
  })

  test('a refusal for one resource keeps the grant', async () => {
    const w = world()
    await w.session.signIn()
    w.plane.refuse(hostAudience('host-1'))
    expect(await w.session.accessToken(HOST)).toBeNull()
    expect(w.session.state().kind).toBe('signed-in')
    expect(await w.session.accessToken({ kind: 'account' })).toBeTruthy()
  })

  test('a refusal is kept with its reason and Solus rule until that resource gets a token', async () => {
    // WHY: a transport that only saw "no token" dialed anyway and logged `unauthorized`, so the reason was lost.
    const w = world()
    await w.session.signIn()
    w.plane.refuse(hostAudience('host-1'), { error: 'access_denied', error_description: 'The person is not a member of an organization.', solus_refusal: 'not_a_member' })
    expect(await w.session.accessToken(HOST)).toBeNull()
    expect(w.session.refusal(HOST)).toEqual({ status: 400, code: 'access_denied', description: 'The person is not a member of an organization.', rule: 'not_a_member' })
    expect(w.session.refusal({ kind: 'account' })).toBeNull()
    w.plane.allow(hostAudience('host-1'))
    expect(await w.session.accessToken(HOST)).toBeTruthy()
    expect(w.session.refusal(HOST)).toBeNull()
  })

  test('a refusal lasts unless the host may be starting or the account plane itself failed', () => {
    const refusal = (status: number, code: string, rule: string | null = null) => ({ status, code, description: null, rule })
    expect(isLastingRefusal(refusal(400, 'invalid_target'))).toBe(true)
    expect(isLastingRefusal(refusal(400, 'access_denied', 'personal_hosts_not_allowed'))).toBe(true)
    expect(isLastingRefusal(refusal(400, 'invalid_target', 'host_not_linked'))).toBe(false)
    expect(isLastingRefusal(refusal(429, 'rate_limited'))).toBe(false)
    expect(isLastingRefusal(refusal(503, 'http_503'))).toBe(false)
    expect(isLastingRefusal(refusal(400, 'invalid_request'))).toBe(false)
  })

  test('invalid_grant ends the sign-in: the store is cleared and the state says revoked', async () => {
    const w = world()
    await w.session.signIn()
    // Another client of the same family replayed a spent token: the plane ended the family.
    const grant = w.memory.current()!
    await w.plane.fetch(`${ISSUER}/api/auth/oauth2/revoke`, { method: 'POST', body: new URLSearchParams({ token: grant.refreshToken }).toString() })
    expect(await w.session.accessToken(HOST)).toBeNull()
    expect(w.session.state()).toEqual({ kind: 'invalid', reason: 'revoked' })
    expect(w.memory.current()).toBeNull()
  })

  test('an account plane that does not answer marks the sign-in stale, and the next answer clears it', async () => {
    const w = world()
    await w.session.signIn()
    w.plane.setDown(true)
    expect(await w.session.accessToken(HOST)).toBeNull()
    expect(w.session.state()).toMatchObject({ kind: 'signed-in', isStale: true })
    w.plane.setDown(false)
    expect(await w.session.accessToken(HOST)).toBeTruthy()
    expect(w.session.state()).toMatchObject({ kind: 'signed-in', isStale: false })
  })
})

describe('OAuthSession identity and sign-out', () => {
  test('refreshIdentity reads /userinfo with an account-plane token and keeps the answer', async () => {
    const w = world()
    await w.session.signIn()
    w.plane.renameInUserinfo('Ada Lovelace')
    await w.session.refreshIdentity()
    expect(w.session.state()).toMatchObject({ identity: { name: 'Ada Lovelace' } })
    expect(w.memory.current()?.identity.name).toBe('Ada Lovelace')
    const userinfo = w.plane.calls.findIndex((call) => call.path === '/api/auth/oauth2/userinfo')
    const refresh = w.plane.calls.findIndex((call) => call.form.get('resource') === ACCOUNT_AUDIENCE)
    expect(refresh).toBeGreaterThan(-1)
    expect(userinfo).toBeGreaterThan(refresh)
  })

  test('sign-out revokes the newest refresh token, then clears the store', async () => {
    const w = world()
    await w.session.signIn()
    await w.session.accessToken(HOST)
    const newest = w.memory.current()!.refreshToken
    await w.session.signOut()
    const revoke = w.plane.calls.find((call) => call.path === '/api/auth/oauth2/revoke')!
    expect(revoke.form.get('token')).toBe(newest)
    expect(revoke.form.get('token_type_hint')).toBe('refresh_token')
    expect(w.plane.isLive(newest)).toBe(false)
    expect(w.memory.current()).toBeNull()
    expect(w.session.state().kind).toBe('signed-out')
    expect(await w.session.accessToken(HOST)).toBeNull()
  })

  test('sign-out waits for a running refresh and revokes the token it gave', async () => {
    let release!: () => void
    let entered!: () => void
    const inside = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const w = world({ gateRefresh: () => { entered(); return gate } })
    await w.session.signIn()
    const running = w.session.accessToken(HOST)
    await inside
    const ended = w.session.signOut()
    release()
    await Promise.all([running, ended])
    const revoke = w.plane.calls.find((call) => call.path === '/api/auth/oauth2/revoke')!
    // The refresh rotated rt-2 into rt-4 while sign-out waited; rt-4 is the one revoked.
    expect(revoke.form.get('token')).toBe('rt-4')
    expect(w.plane.liveTokens()).toEqual([])
    expect(w.memory.current()).toBeNull()
  })

  test('sign-out clears the store even when the account plane does not answer', async () => {
    const w = world()
    await w.session.signIn()
    w.plane.setDown(true)
    await w.session.signOut()
    expect(w.memory.current()).toBeNull()
    expect(w.session.state().kind).toBe('signed-out')
  })

  test('a stored grant signs the client in at start, and device-grant tokens can be adopted', async () => {
    const w = world()
    await w.session.signIn()
    const again = new OAuthSession({ cloudOrigin: ISSUER, clientId: w.plane.clientId, store: w.memory.store, fetch: w.plane.fetch, now: w.plane.now })
    expect(again.state()).toMatchObject({ kind: 'signed-in', identity: { sub: 'user-1' } })

    const cli = memoryStore()
    const device = new OAuthSession({ cloudOrigin: ISSUER, clientId: w.plane.clientId, store: cli.store, fetch: w.plane.fetch, now: w.plane.now })
    expect(await device.adoptTokens(w.plane.deviceTokens())).toBe('approved')
    expect(await device.accessToken({ kind: 'account' })).toBeTruthy()
  })
})
