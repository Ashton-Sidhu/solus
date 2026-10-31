import { afterEach, describe, expect, test } from 'bun:test'
import { WebTokenSession, type SignOutChannel } from '@solus/client-core/web-token-session'
import { WEB_TOKENS_PATH } from '@solus/contracts/uplink'

// docs/plans/web-session-tokens.md, decision 5: the page on the account origin runs no
// OAuth flow and holds no refresh token. It asks `POST /api/web/tokens` with its session
// cookie: at boot for every host of the shell at once, and again only when a token is
// asked for within a minute of its end. One request is in flight at a time; there is no
// timer. A 401, or a sign-out in any tab, signs out every tab of the origin (decision 6).

const ORIGIN = 'https://app.example'
const HOUR = 3_600_000

interface Answer {
  status?: number
  hosts?: Array<{ hostId: string; refused?: string }>
}

/** One `BroadcastChannel` name: what one tab posts, every other tab of the origin hears. */
function broadcast() {
  const listeners: Array<{ owner: object; listener: () => void }> = []
  return (): SignOutChannel => {
    const owner = {}
    return {
      postMessage: () => { for (const each of listeners) if (each.owner !== owner) each.listener() },
      addEventListener: ((_type: string, listener: () => void) => { listeners.push({ owner, listener }) }) as SignOutChannel['addEventListener'],
    }
  }
}

function world(answers: Answer[] = [], channel: SignOutChannel | null = null) {
  let now = 1_000_000
  let serial = 0
  const requests: Array<{ url: string; init: RequestInit | undefined; hostIds: string[] }> = []
  const pending: Array<() => void> = []
  let isHeld = false
  let signedOut = 0
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const hostIds: string[] = url.endsWith(WEB_TOKENS_PATH) ? JSON.parse(String(init?.body)).hostIds : []
    requests.push({ url, init, hostIds })
    if (isHeld) await new Promise<void>((resolve) => pending.push(resolve))
    if (!url.endsWith(WEB_TOKENS_PATH)) return new Response(null, { status: 200 })
    const answer = answers.shift() ?? {}
    if (answer.status) return Response.json({ error: 'unauthorized' }, { status: answer.status })
    serial += 1
    const asked: NonNullable<Answer['hosts']> = answer.hosts ?? hostIds.map((hostId) => ({ hostId }))
    const hosts = asked.map((host) =>
      host.refused ? { hostId: host.hostId, refused: host.refused } : { hostId: host.hostId, token: `host-${host.hostId}-${serial}`, expiresAt: now + HOUR })
    return Response.json({ serversToken: { token: `servers-${serial}`, expiresAt: now + 8 * HOUR }, hosts })
  }
  const session = new WebTokenSession({
    origin: ORIGIN,
    identity: { sub: 'user-1', email: 'a@example.test', emailVerified: true, name: 'Ada', picture: null },
    signedInAt: 5,
    fetch: fetchImpl,
    now: () => now,
    onSignedOut: () => { signedOut += 1 },
    channel,
  })
  return {
    session, requests,
    tokenRequests: () => requests.filter((request) => request.url.endsWith(WEB_TOKENS_PATH)),
    advance: (ms: number) => { now += ms },
    hold: () => { isHeld = true },
    release: () => { isHeld = false; for (const resolve of pending.splice(0)) resolve() },
    signedOutCount: () => signedOut,
  }
}

const writes: string[] = []
const storage = { getItem: () => null, setItem: (key: string) => { writes.push(key) }, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 }
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
afterEach(() => { writes.length = 0 })

describe('WebTokenSession', () => {
  test('is signed in from the shell, before any request', () => {
    const w = world()
    expect(w.session.state()).toEqual({ kind: 'signed-in', identity: expect.objectContaining({ sub: 'user-1' }), consoleUrl: ORIGIN, signedInAt: 5, isStale: false })
    expect(w.requests).toHaveLength(0)
  })

  test('the boot request goes at once, with the cookie and every host of the shell, and nothing is written to storage', async () => {
    // WHY: the first answer gives every dial its token, beside the workspace code; a
    // refresh token in web storage is what this design removes.
    const w = world()
    w.session.start(['host-a', 'host-b'])
    expect(w.requests).toHaveLength(1)
    expect(w.requests[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' })
    expect(w.requests[0]!.hostIds).toEqual(['host-a', 'host-b'])
    expect(await w.session.accessToken({ kind: 'host', hostId: 'host-a' })).toBe('host-host-a-1')
    expect(await w.session.accessToken({ kind: 'host', hostId: 'host-b' })).toBe('host-host-b-1')
    expect(await w.session.accessToken({ kind: 'api' })).toBe('servers-1')
    expect(w.tokenRequests()).toHaveLength(1)
    expect(writes).toEqual([])
  })

  test('one request is in flight at a time: an ask it carries waits for it, any other ask follows it', async () => {
    // WHY: two requests for one token would sign two tokens for nothing.
    const w = world()
    w.hold()
    w.session.start(['host-a'])
    const a = w.session.accessToken({ kind: 'host', hostId: 'host-a' })
    const servers = w.session.accessToken({ kind: 'account' })
    const b = w.session.accessToken({ kind: 'host', hostId: 'host-b' })
    expect(w.tokenRequests()).toHaveLength(1)
    w.release()
    expect(await a).toBe('host-host-a-1')
    expect(await servers).toBe('servers-1')
    expect(await b).toBe('host-host-b-2')
    expect(w.tokenRequests().map((request) => request.hostIds)).toEqual([['host-a'], ['host-b']])
  })

  test('renews a token only when it is asked for within a minute of its end', async () => {
    // WHY: no timer runs; the host socket asks before its token ends, so a renewal costs
    // a request only for a token in use.
    const w = world()
    w.session.start(['host-a'])
    expect(await w.session.accessToken({ kind: 'host', hostId: 'host-a' })).toBe('host-host-a-1')
    w.advance(HOUR - 61_000)
    expect(await w.session.accessToken({ kind: 'host', hostId: 'host-a' })).toBe('host-host-a-1')
    expect(w.tokenRequests()).toHaveLength(1)
    w.advance(2_000)
    expect(await w.session.accessToken({ kind: 'host', hostId: 'host-a' })).toBe('host-host-a-2')
    expect(w.tokenRequests().map((request) => request.hostIds)).toEqual([['host-a'], ['host-a']])
  })

  test('a token a host refused is not given out again', async () => {
    const w = world()
    w.session.start(['host-a'])
    const first = await w.session.accessToken({ kind: 'host', hostId: 'host-a' })
    expect(await w.session.accessToken({ kind: 'host', hostId: 'host-a' }, { refused: first! })).toBe('host-host-a-2')
  })

  test('a refused host has no token and says why; the others still get theirs', async () => {
    const w = world([{ hosts: [{ hostId: 'host-a', refused: 'personal_hosts_not_allowed' }, { hostId: 'host-b' }] }])
    w.session.start(['host-a', 'host-b'])
    expect(await w.session.accessToken({ kind: 'host', hostId: 'host-a' })).toBeNull()
    expect(w.session.refusal({ kind: 'host', hostId: 'host-a' })).toMatchObject({ rule: 'personal_hosts_not_allowed' })
    expect(await w.session.accessToken({ kind: 'host', hostId: 'host-b' })).toBe('host-host-b-1')
  })

  test('a 401 means the website session ended: signed out, no token, and the page leaves for the sign-in', async () => {
    // WHY: the session is the credential; once it ends, nothing may keep dialing with old tokens.
    const w = world([{ status: 401 }])
    w.session.start(['host-a'])
    expect(await w.session.accessToken({ kind: 'host', hostId: 'host-a' })).toBeNull()
    expect(w.session.state()).toEqual({ kind: 'invalid', reason: 'revoked' })
    expect(w.signedOutCount()).toBe(1)
    expect(await w.session.accessToken({ kind: 'api' })).toBeNull()
    expect(w.tokenRequests()).toHaveLength(1)
  })

  test('a 401 in one tab signs every tab of the origin out', async () => {
    // WHY: the website session is one for every tab; a tab that learned it ended tells the
    // others, so none keeps showing a workspace it can no longer reach.
    const channelOf = broadcast()
    const first = world([{ status: 401 }], channelOf())
    const second = world([], channelOf())
    second.session.start([])
    expect(await second.session.accessToken({ kind: 'account' })).toBe('servers-1')
    first.session.start([])
    await first.session.accessToken({ kind: 'account' })
    expect(second.session.state()).toEqual({ kind: 'signed-out' })
    expect(second.signedOutCount()).toBe(1)
    expect(await second.session.accessToken({ kind: 'account' })).toBeNull()
    expect(second.tokenRequests()).toHaveLength(1)
  })

  test('no answer marks the sign-in stale and keeps it; the next ask tries again', async () => {
    const w = world([{ status: 503 }])
    w.session.start([])
    expect(await w.session.accessToken({ kind: 'account' })).toBeNull()
    expect(w.session.state()).toMatchObject({ kind: 'signed-in', isStale: true })
    expect(await w.session.accessToken({ kind: 'account' })).toBe('servers-1')
    expect(w.session.state()).toMatchObject({ kind: 'signed-in', isStale: false })
  })

  test('sign-out ends the website session, drops every token, and signs out the other tabs', async () => {
    const channelOf = broadcast()
    const w = world([], channelOf())
    const other = world([], channelOf())
    w.session.start([])
    await w.session.accessToken({ kind: 'account' })
    expect(await w.session.signOut()).toBe(true)
    expect(w.requests.at(-1)).toMatchObject({ url: `${ORIGIN}/api/auth/sign-out`, init: { method: 'POST', credentials: 'same-origin' } })
    expect(w.session.state()).toEqual({ kind: 'signed-out' })
    expect(await w.session.accessToken({ kind: 'account' })).toBeNull()
    expect(other.session.state()).toEqual({ kind: 'signed-out' })
    expect(other.signedOutCount()).toBe(1)
  })
})
