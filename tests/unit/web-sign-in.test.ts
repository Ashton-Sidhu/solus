import { describe, expect, test } from 'bun:test'
import { OAuthSession, type StoredGrant } from '@solus/client-core/oauth-session'
import { resumeWebSignIn, SILENT_RETRY_AFTER_MS, webTokenStore, type KeyValueStorage, type PageLifecycle } from '@solus/client-core/web-sign-in'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

// The web client signs in on the account origin with a top-level redirect: the
// website's cookie approves it silently, and `/auth/callback` completes it on the same
// page (ADR 0001 §2.2 rule 1). The refresh token lives in page memory and crosses a
// reload through sessionStorage only, so a duplicated tab never shares it (§5 replay).

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

function world(path: string, options: { signedIn?: boolean } = {}) {
  const plane = fakeAccountPlane({ clientId: 'solus-web' })
  const storage = memoryStorage()
  const session = new OAuthSession({ cloudOrigin: ISSUER, clientId: 'solus-web', store: webTokenStore(memoryStorage(), page()), fetch: plane.fetch, now: plane.now })
  const navigations: string[] = []
  const location = { origin: ISSUER, pathname: path, search: '', hash: '', href: `${ISSUER}${path}` }
  let address = path
  const deps = {
    session, storage, location,
    navigate: (url: string) => { navigations.push(url) },
    replaceAddress: (next: string) => { address = next },
    whenSignedOut: (returnTo: string) => (returnTo.startsWith('/w/') ? 'stay' as const : 'sign-in' as const),
    now: plane.now,
  }
  /** The browser follows the redirect: the website answers the callback, and the page loads there. */
  const arriveAtCallback = (answer: 'approve' | 'login_required') => {
    const authorize = new URL(navigations.at(-1)!)
    const callback = answer === 'approve' ? plane.approve(authorize) : new URL(`${ISSUER}/auth/callback?error=login_required&state=${authorize.searchParams.get('state')}`)
    Object.assign(location, { pathname: callback.pathname, search: callback.search, href: callback.toString() })
  }
  return { plane, storage, session, deps, navigations, arriveAtCallback, address: () => address }
}

describe('resumeWebSignIn', () => {
  test('a page with no sign-in starts one silent sign-in, and the callback signs it in and restores the address', async () => {
    const w = world('/tasks/42')
    w.deps.location.search = '?view=board'
    w.deps.location.hash = '#top'
    expect(await resumeWebSignIn(w.deps)).toBe('redirecting')
    const authorize = new URL(w.navigations[0]!)
    expect(authorize.searchParams.get('prompt')).toBe('none')
    expect(authorize.searchParams.get('client_id')).toBe('solus-web')
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ISSUER}/auth/callback`)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')

    w.arriveAtCallback('approve')
    expect(await resumeWebSignIn(w.deps)).toBe('signed-in')
    expect(w.session.state()).toMatchObject({ kind: 'signed-in', identity: { sub: 'user-1' } })
    expect(w.address()).toBe('/tasks/42?view=board#top')
  })

  test('no website session sends a member to sign in, and a guest stays on the share link signed out', async () => {
    const member = world('/tasks/42')
    await resumeWebSignIn(member.deps)
    member.arriveAtCallback('login_required')
    expect(await resumeWebSignIn(member.deps)).toBe('redirecting')
    expect(member.navigations.at(-1)).toBe(`${ISSUER}/sign-in?next=${encodeURIComponent('/tasks/42')}`)

    const guest = world('/w/res_1')
    guest.deps.location.hash = '#secret'
    await resumeWebSignIn(guest.deps)
    guest.arriveAtCallback('login_required')
    expect(await resumeWebSignIn(guest.deps)).toBe('signed-out')
    expect(guest.address()).toBe('/w/res_1#secret')
    expect(guest.navigations).toHaveLength(1)
  })

  test('a silent sign-in that did not sign the page in is not tried again at once, so it cannot loop', async () => {
    const w = world('/w/res_1')
    await resumeWebSignIn(w.deps)
    w.arriveAtCallback('login_required')
    await resumeWebSignIn(w.deps)
    Object.assign(w.deps.location, { pathname: '/w/res_1', search: '' })
    expect(await resumeWebSignIn(w.deps)).toBe('signed-out')
    expect(w.navigations).toHaveLength(1)
    w.plane.advance(SILENT_RETRY_AFTER_MS)
    expect(await resumeWebSignIn(w.deps)).toBe('redirecting')
  })

  test('a callback this page did not start is refused and leaves the callback address', async () => {
    const w = world('/auth/callback')
    w.deps.location.href = `${ISSUER}/auth/callback?code=stolen&state=x`
    expect(await resumeWebSignIn(w.deps)).toBe('signed-out')
    expect(w.session.state().kind).toBe('signed-out')
    expect(w.address()).toBe('/')
  })
})
