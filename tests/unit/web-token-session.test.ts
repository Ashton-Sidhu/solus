import { afterEach, describe, expect, test } from 'bun:test'
import { WebTokenSession } from '@solus/client-core/web-token-session'
import { WEB_TOKENS_PATH } from '@solus/contracts/uplink'

// docs/plans/fast-secure-startup.md, decision 1: the page on the account origin runs no
// OAuth flow and holds no refresh token. It asks `POST /api/web/tokens` with its session
// cookie, once at boot for every host at a time, and again shortly before the tokens end.

const ORIGIN = 'https://app.example'
const HOUR = 3_600_000

interface Answer {
  status?: number
  hosts?: Array<{ hostId: string; refused?: string }>
}

function world(answers: Answer[] = []) {
  let now = 1_000_000
  let serial = 0
  const requests: Array<{ url: string; init: RequestInit | undefined; hostIds: string[] }> = []
  const pending: Array<() => void> = []
  let isHeld = false
  const timers: Array<{ renew: () => void; delayMs: number; isCancelled: boolean }> = []
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
    const hosts = (answer.hosts ?? hostIds.map((hostId) => ({ hostId }))).map((host) =>
      host.refused ? { hostId: host.hostId, refused: host.refused } : { hostId: host.hostId, token: `host-${host.hostId}-${serial}`, expiresAt: now + 8 * HOUR })
    return Response.json({ serversToken: { token: `servers-${serial}`, expiresAt: now + 8 * HOUR }, hosts })
  }
  const session = new WebTokenSession({
    origin: ORIGIN,
    identity: { sub: 'user-1', email: 'a@example.test', emailVerified: true, name: 'Ada', picture: null },
    signedInAt: 5,
    fetch: fetchImpl,
    now: () => now,
    onSignedOut: () => { signedOut += 1 },
    schedule: (renew, delayMs) => {
      const timer = { renew, delayMs, isCancelled: false }
      timers.push(timer)
      return () => { timer.isCancelled = true }
    },
  })
  return {
    session, requests, timers,
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
    // WHY: the first answer gives every dial its token; a refresh token in web storage is what this design removes.
    const w = world()
    w.session.start(['host-a', 'host-b'])
    expect(w.requests).toHaveLength(1)
    expect(w.requests[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(w.requests[0]!.hostIds).toEqual(['host-a', 'host-b'])
    expect(await w.session.accessToken({ kind: 'host', hostId: 'host-a' })).toBe('host-host-a-1')
    expect(await w.session.accessToken({ kind: 'host', hostId: 'host-b' })).toBe('host-host-b-1')
    expect(await w.session.accessToken({ kind: 'api' })).toBe('servers-1')
    expect(w.tokenRequests()).toHaveLength(1)
    expect(writes).toEqual([])
  })

  test('hosts asked for in one turn share one request; a host asked for during a request waits for the next one', async () => {
    const w = world()
    w.hold()
    w.session.start(['host-a'])
    const a = w.session.accessToken({ kind: 'host', hostId: 'host-a' })
    const b = w.session.accessToken({ kind: 'host', hostId: 'host-b' })
    const c = w.session.accessToken({ kind: 'host', hostId: 'host-c' })
    w.release()
    await a
    w.release()
    expect(await b).toBe('host-host-b-2')
    expect(await c).toBe('host-host-c-2')
    expect(w.tokenRequests().map((request) => request.hostIds)).toEqual([['host-a'], ['host-b', 'host-c']])
  })

  test('renews every held token shortly before the first one ends', async () => {
    const w = world()
    w.session.start(['host-a'])
    await w.session.accessToken({ kind: 'host', hostId: 'host-a' })
    const timer = w.timers.at(-1)!
    expect(timer.delayMs).toBe(8 * HOUR - 60_000)
    w.advance(timer.delayMs)
    timer.renew()
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

  test('no answer marks the sign-in stale and keeps it; the next ask tries again', async () => {
    const w = world([{ status: 503 }])
    w.session.start([])
    expect(await w.session.accessToken({ kind: 'account' })).toBeNull()
    expect(w.session.state()).toMatchObject({ kind: 'signed-in', isStale: true })
    expect(await w.session.accessToken({ kind: 'account' })).toBe('servers-1')
    expect(w.session.state()).toMatchObject({ kind: 'signed-in', isStale: false })
  })

  test('sign-out ends the website session and drops every token', async () => {
    const w = world()
    w.session.start([])
    await w.session.accessToken({ kind: 'account' })
    expect(await w.session.signOut()).toBe(true)
    expect(w.requests.at(-1)).toMatchObject({ url: `${ORIGIN}/api/auth/sign-out`, init: { method: 'POST', credentials: 'same-origin' } })
    expect(w.session.state()).toEqual({ kind: 'signed-out' })
    expect(await w.session.accessToken({ kind: 'account' })).toBeNull()
    expect(w.timers.every((timer) => timer.isCancelled)).toBe(true)
  })
})
