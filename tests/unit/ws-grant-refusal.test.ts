import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { WsTransport, type GrantRefusal } from '@solus/client-core/ws-transport'
import type { DialOutcome } from '@solus/client-core/host-supervisor'

// When the account plane gives no grant for a host, a dial can only end in the host's
// `unauthorized`. The transport used to dial anyway, so the reason (here, a provider
// bug that refused every host token) never left the token response. Now it skips the
// socket, logs why, and stops at once on a refusal that stands until the account changes.

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

/** A host that counts every request it gets, socket opens included. */
async function host() {
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(401, { 'content-type': 'application/json' }).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => server.close())
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => requests }
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
}

async function refusedTransport(refusal: GrantRefusal | null, isSignedOut: () => boolean = () => false) {
  const target = await host()
  const outcomes: DialOutcome['kind'][] = []
  let authFailures = 0
  const transport = new WsTransport({
    serverUrl: target.url,
    sessionToken: '',
    grants: { acquire: async () => null, refusal: () => refusal, isSignedOut },
    onDialOutcome: (outcome) => outcomes.push(outcome.kind),
    onAuthFailed: () => { authFailures += 1 },
  })
  cleanups.push(() => transport.destroy())
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  cleanups.push(() => warn.mockRestore())
  /** One dial, as the supervisor asks for it, until its outcome. */
  const dial = async () => {
    const before = outcomes.length
    transport.start()
    await until(() => outcomes.length > before)
  }
  return { target, transport, outcomes, warn, dial, authFailures: () => authFailures }
}

describe('a dial the account plane refused a grant for', () => {
  test('opens no socket, asks the host for nothing, and logs the reason', async () => {
    const w = await refusedTransport({ lasting: false, reason: 'invalid_target: host_not_linked: This host is not linked. (HTTP 400)' })
    await w.dial()
    expect(w.outcomes).toEqual(['dial-failed'])
    expect(w.target.requests()).toBe(0)
    expect(w.warn).toHaveBeenCalledWith('[solus:ws] account refused a grant for this host', expect.objectContaining({ reason: 'invalid_target: host_not_linked: This host is not linked. (HTTP 400)', lasting: false }))
  })

  test('a lasting refusal blocks the host at once, until the person retries', async () => {
    // WHY: the exchange answers in one round trip with no rotation, so there is no
    // flaky refresh to count past: a person who cannot reach the host cannot.
    const w = await refusedTransport({ lasting: true, reason: 'invalid_target: requested resource invalid (HTTP 400)' })
    await w.dial()
    expect(w.outcomes).toEqual(['auth-blocked'])
    expect(w.authFailures()).toBe(1)
    await w.dial()
    expect(w.outcomes).toEqual(['auth-blocked', 'auth-blocked'])
    expect(w.target.requests()).toBe(0)
  })

  test('a refusal that may pass never blocks', async () => {
    const w = await refusedTransport({ lasting: false, reason: 'http_503 (HTTP 503)' })
    for (let dial = 0; dial < 4; dial++) await w.dial()
    expect(w.outcomes.every((kind) => kind === 'dial-failed')).toBe(true)
    expect(w.authFailures()).toBe(0)
  })
})

// A tab open for a long time outlives its sign-in: the refresh token expires and the
// account ends the grant. The page then has no token for any host, and every dial
// was refused as a dropped connection, so the host showed "Reconnecting" forever.
describe('a dial while the account holds no sign-in', () => {
  test('blocks the host at once as needing sign-in, and asks the host for nothing', async () => {
    const w = await refusedTransport(null, () => true)
    await w.dial()
    expect(w.outcomes).toEqual(['auth-blocked'])
    expect(w.authFailures()).toBe(1)
    expect(w.target.requests()).toBe(0)
  })

  test('with a sign-in, no token is a failure to retry: the website may not have answered', async () => {
    const w = await refusedTransport(null)
    for (let dial = 0; dial < 4; dial++) await w.dial()
    expect(w.outcomes.every((kind) => kind === 'dial-failed')).toBe(true)
    expect(w.authFailures()).toBe(0)
    // No token means no socket: a dial without one could only be refused.
    expect(w.target.requests()).toBe(0)
  })
})
