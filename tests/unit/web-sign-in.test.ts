import { describe, expect, test } from 'bun:test'
import { OAuthSession } from '@solus/client-core/oauth-session'
import { fetchAuthorize, keepWebSignIn, resumeWebSignIn, webGrantSharing, webTokenStore, type KeyValueStorage, type RefreshLocks } from '@solus/client-core/web-sign-in'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

// The web client signs in on the account origin with one same-origin fetch: the
// website's cookie approves it silently and the provider answers the callback address
// as JSON, so no page loads (ADR 0001 §2.2 rule 1; docs/plans/instant-share-open.md).
// Every tab shares one grant in localStorage; a refresh runs under one lock across the
// tabs and starts from the stored grant, so no tab ever presents a spent refresh
// token, which the account plane reads as a replay and ends the grant (§5).

function memoryStorage(): KeyValueStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value) }, removeItem: (key) => { items.delete(key) } }
}

/** One lock for every tab, as `navigator.locks` gives an origin. */
function oneLock(): RefreshLocks {
  let chain: Promise<unknown> = Promise.resolve()
  return {
    request<T>(_name: string, run: () => Promise<T>): Promise<T> {
      const turn = chain.then(run)
      chain = turn.then(() => undefined, () => undefined)
      return turn
    },
  }
}

/** Tabs of one origin: one localStorage, one lock, one account plane. The first tab signs in. */
async function tabs() {
  const plane = fakeAccountPlane({ clientId: 'solus-web' })
  const storage = memoryStorage()
  const locks = oneLock()
  const open = () => new OAuthSession({ cloudOrigin: ISSUER, clientId: 'solus-web', store: webTokenStore(storage), sharing: webGrantSharing(storage, locks), fetch: plane.fetch, now: plane.now })
  const first = open()
  const { authorizeUrl, pending } = await first.beginSignIn(`${ISSUER}/auth/callback`)
  expect(await first.completeSignIn(plane.approve(authorizeUrl), pending)).toBe('approved')
  return { plane, open, first }
}

const refreshes = (plane: ReturnType<typeof fakeAccountPlane>) => plane.calls.filter((call) => call.form.get('grant_type') === 'refresh_token').length

describe('one sign-in for every tab', () => {
  test('a new tab is signed in at once', async () => {
    const { open } = await tabs()
    expect(open().state().kind).toBe('signed-in')
  })

  test('two tabs that refresh at the same time keep the grant alive and share one token', async () => {
    const { plane, open, first } = await tabs()
    const second = open()
    const [a, b] = await Promise.all([first.accessToken({ kind: 'api' }), second.accessToken({ kind: 'api' })])
    expect(a).not.toBeNull()
    expect(a).toBe(b)
    expect(refreshes(plane)).toBe(1)
    expect(plane.liveTokens()).toHaveLength(1)
    expect(second.state().kind).toBe('signed-in')
  })

  test('a tab refreshes from the grant another tab rotated, never from its own spent copy', async () => {
    const { plane, open, first } = await tabs()
    const second = open()
    expect(await first.accessToken({ kind: 'host', hostId: 'h1' })).not.toBeNull()
    expect(await second.accessToken({ kind: 'host', hostId: 'h2' })).not.toBeNull()
    expect(await first.accessToken({ kind: 'api' })).not.toBeNull()
    expect(plane.liveTokens()).toHaveLength(1)
    expect([first.state().kind, second.state().kind]).toEqual(['signed-in', 'signed-in'])
  })

  test('a new tab takes the servers token another tab minted, and exchanges it for a host with no refresh', async () => {
    const { plane, open, first } = await tabs()
    const token = await first.accessToken({ kind: 'api' })
    const before = plane.calls.length
    const second = open()
    expect(await second.accessToken({ kind: 'account' })).toBe(token)
    expect(plane.calls.length).toBe(before)
    expect(await second.accessToken({ kind: 'host', hostId: 'h1' })).toBeTruthy()
    expect(refreshes(plane)).toBe(1)
  })

  test('a sign-out in one tab signs the others out', async () => {
    const { open, first } = await tabs()
    const second = open()
    await first.signOut()
    second.syncWithStore()
    expect(second.state().kind).toBe('signed-out')
    expect(await second.accessToken({ kind: 'host', hostId: 'h1' })).toBeNull()
  })
})

function world(path: string, answer: 'approve' | 'login_required' | 'none' = 'approve') {
  const plane = fakeAccountPlane({ clientId: 'solus-web' })
  const session = new OAuthSession({ cloudOrigin: ISSUER, clientId: 'solus-web', store: webTokenStore(memoryStorage()), fetch: plane.fetch, now: plane.now })
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
  /** The website's answer from now on: its cookie session ended, or it stopped answering. */
  const setAnswer = (next: typeof answer) => { answer = next }
  return { plane, session, deps, navigations, authorized, setAnswer }
}

/** The account plane ends the grant (the refresh token expired or was revoked); the next refresh finds out. */
async function endGrant(w: ReturnType<typeof world>): Promise<void> {
  for (const token of w.plane.liveTokens()) {
    await w.plane.fetch(`${ISSUER}/api/auth/oauth2/revoke`, { method: 'POST', body: new URLSearchParams({ token }).toString() })
  }
  expect(await w.session.accessToken({ kind: 'host', hostId: 'h1' })).toBeNull()
}

// A tab open for a long time outlives its grant. It used to keep the ended sign-in and
// redial every host forever ("Reconnecting"); it now signs in again the way boot does.
describe('keepWebSignIn', () => {
  test('a grant that ends is made again silently, and hosts dial again', async () => {
    const w = world('/tasks/42')
    await resumeWebSignIn(w.deps)
    let redials = 0
    const signedInAgain = new Promise<void>((resolve) => keepWebSignIn(w.deps, () => { redials += 1; resolve() }))
    await endGrant(w)
    await signedInAgain
    expect(w.session.state()).toMatchObject({ kind: 'signed-in', identity: { sub: 'user-1' } })
    expect(await w.session.accessToken({ kind: 'host', hostId: 'h1' })).not.toBeNull()
    expect(redials).toBe(1)
    expect(w.navigations).toEqual([])
  })

  test('with no website session either, the page goes to the website sign-in and back', async () => {
    const w = world('/tasks/42')
    await resumeWebSignIn(w.deps)
    keepWebSignIn(w.deps, () => { throw new Error('no silent sign-in was made') })
    w.setAnswer('login_required')
    await endGrant(w)
    await until(() => w.navigations.length > 0)
    expect(w.navigations).toEqual([`${ISSUER}/sign-in?next=${encodeURIComponent('/tasks/42')}`])
  })

  test('a sign-out stays signed out', async () => {
    const w = world('/tasks/42')
    await resumeWebSignIn(w.deps)
    keepWebSignIn(w.deps, () => {})
    await w.session.signOut()
    await Promise.resolve()
    expect(w.session.state().kind).toBe('signed-out')
    expect(w.authorized).toHaveLength(1)
  })
})

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
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
