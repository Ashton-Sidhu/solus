import { describe, expect, test } from 'bun:test'
import { OAuthSession, type StoredGrant } from '@solus/client-core/oauth-session'
import { fetchAuthorize, resumeWebSignIn, webTokenStore, type KeyValueStorage, type PageLifecycle } from '@solus/client-core/web-sign-in'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

// The web client signs in on the account origin with one same-origin fetch: the
// website's cookie approves it silently and the provider answers the callback address
// as JSON, so no page loads (ADR 0001 §2.2 rule 1; docs/plans/instant-share-open.md).
// The refresh token lives in page memory and crosses a reload through sessionStorage
// only, so a duplicated tab never shares it (§5 replay).

function memoryStorage(): KeyValueStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value) }, removeItem: (key) => { items.delete(key) } }
}

function page(): PageLifecycle & { fire(type: 'pagehide' | 'pageshow'): void } {
  const listeners: Array<[string, () => void]> = []
  return {
    addEventListener: (type, listener) => { listeners.push([type, listener]) },
    fire: (type) => { for (const [name, listener] of listeners) if (name === type) listener() },
  }
}

const GRANT: StoredGrant = { refreshToken: 'rt', idToken: 'h.p.s', identity: { sub: 'u', email: 'a@b.co', emailVerified: true, name: null, picture: null }, signedInAt: 1 }

describe('web token store', () => {
  test('a reload keeps the grant: it is written when the page goes and taken back by the next page', () => {
    const storage = memoryStorage()
    const first = page()
    const store = webTokenStore(storage, first)
    expect(store.load()).toBeNull()
    store.save(GRANT)
    // While the page lives, nothing is in sessionStorage for a duplicated tab to copy.
    expect(storage.items.size).toBe(0)
    first.fire('pagehide')
    const next = webTokenStore(storage, page())
    expect(next.load()).toEqual(GRANT)
    expect(storage.items.size).toBe(0)
  })

  test('a page restored from the back-forward cache takes its copy back', () => {
    const storage = memoryStorage()
    const lifecycle = page()
    const store = webTokenStore(storage, lifecycle)
    store.save(GRANT)
    lifecycle.fire('pagehide')
    lifecycle.fire('pageshow')
    expect(storage.items.size).toBe(0)
  })
})

function world(path: string, answer: 'approve' | 'login_required' | 'none' = 'approve') {
  const plane = fakeAccountPlane({ clientId: 'solus-web' })
  const session = new OAuthSession({ cloudOrigin: ISSUER, clientId: 'solus-web', store: webTokenStore(memoryStorage(), page()), fetch: plane.fetch, now: plane.now })
  const navigations: string[] = []
  const authorized: URL[] = []
  const location = { origin: ISSUER, pathname: path, search: '', hash: '' }
  const deps = {
    session, location,
    navigate: (url: string) => { navigations.push(url) },
    whenSignedOut: (returnTo: string) => (returnTo.startsWith('/w/') ? 'stay' as const : 'sign-in' as const),
    /** The website answers the authorize request from its cookie, as the provider does for a fetch that accepts JSON. */
    authorize: async (authorizeUrl: URL) => {
      authorized.push(authorizeUrl)
      if (answer === 'none') return null
      return answer === 'approve' ? plane.approve(authorizeUrl) : new URL(`${ISSUER}/auth/callback?error=login_required&state=${authorizeUrl.searchParams.get('state')}`)
    },
  }
  return { session, deps, navigations, authorized }
}

describe('resumeWebSignIn', () => {
  test('a page with no sign-in signs in silently, with no page load and no change of address', async () => {
    const w = world('/s/sess_1')
    w.deps.location.hash = '#secret'
    expect(await resumeWebSignIn(w.deps)).toBe('signed-in')
    const authorize = w.authorized[0]!
    expect(authorize.searchParams.get('prompt')).toBe('none')
    expect(authorize.searchParams.get('client_id')).toBe('solus-web')
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ISSUER}/auth/callback`)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(w.session.state()).toMatchObject({ kind: 'signed-in', identity: { sub: 'user-1' } })
    expect(w.navigations).toEqual([])
  })

  test('a tab that holds a sign-in asks for nothing', async () => {
    const w = world('/tasks/42')
    await resumeWebSignIn(w.deps)
    expect(await resumeWebSignIn(w.deps)).toBe('signed-in')
    expect(w.authorized).toHaveLength(1)
  })

  test('no website session sends a member to sign in and back, and keeps a guest on the share link signed out', async () => {
    const member = world('/tasks/42', 'login_required')
    member.deps.location.search = '?view=board'
    expect(await resumeWebSignIn(member.deps)).toBe('redirecting')
    expect(member.navigations).toEqual([`${ISSUER}/sign-in?next=${encodeURIComponent('/tasks/42?view=board')}`])

    const guest = world('/w/res_1', 'login_required')
    guest.deps.location.hash = '#secret'
    expect(await resumeWebSignIn(guest.deps)).toBe('signed-out')
    expect(guest.navigations).toEqual([])
  })

  test('no answer from the website leaves the page signed out, where it is', async () => {
    const w = world('/tasks/42', 'none')
    expect(await resumeWebSignIn(w.deps)).toBe('signed-out')
    expect(w.navigations).toEqual([])
  })
})

describe('fetchAuthorize', () => {
  const AUTHORIZE = new URL(`${ISSUER}/api/auth/oauth2/authorize?client_id=solus-web`)

  test('asks for JSON with the page\'s own cookie, and follows no redirect', async () => {
    let sent: RequestInit | undefined
    const callback = `${ISSUER}/auth/callback?code=c1&state=s1`
    const answer = await fetchAuthorize(AUTHORIZE, async (_input, init) => {
      sent = init
      return Response.json({ redirect: true, url: callback })
    })
    expect(answer?.toString()).toBe(callback)
    expect(new Headers(sent?.headers).get('accept')).toBe('application/json')
    expect(sent?.credentials).toBe('same-origin')
    expect(sent?.redirect).toBe('manual')
  })

  test('an address off this origin or off the callback, or any other answer, is no callback', async () => {
    const answering = (body: unknown, status = 200): typeof fetch => async () => Response.json(body, { status })
    expect(await fetchAuthorize(AUTHORIZE, answering({ redirect: true, url: 'https://evil.test/auth/callback?code=c' }))).toBeNull()
    expect(await fetchAuthorize(AUTHORIZE, answering({ redirect: true, url: `${ISSUER}/elsewhere?code=c` }))).toBeNull()
    expect(await fetchAuthorize(AUTHORIZE, answering({ error: 'invalid_client' }, 400))).toBeNull()
    expect(await fetchAuthorize(AUTHORIZE, async () => { throw new TypeError('offline') })).toBeNull()
  })
})
