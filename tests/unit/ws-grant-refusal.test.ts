import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { LASTING_REFUSALS_BEFORE_BLOCK, WsTransport, type GrantRefusal } from '@solus/client-core/ws-transport'
import type { DialOutcome } from '@solus/client-core/host-supervisor'

// When the account plane gives no grant for a host, a dial can only end in the host's
// `unauthorized`. The transport used to dial anyway, so the reason (here, a provider
// bug that refused every host token) never left the token response. Now it skips the
// socket, logs why, and stops after a refusal keeps coming back the same way.

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

/** A host that counts every request it gets: ticket requests and socket opens alike. */
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

async function refusedTransport(refusal: GrantRefusal) {
  const target = await host()
  const outcomes: DialOutcome['kind'][] = []
  let authFailures = 0
  const transport = new WsTransport({
    serverUrl: target.url,
    sessionToken: '',
    acquireGrant: async () => null,
    grantRefusal: () => refusal,
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

  test('a lasting refusal blocks the host after it comes back the same way, until the person retries', async () => {
    const w = await refusedTransport({ lasting: true, reason: 'invalid_target: requested resource invalid (HTTP 400)' })
    for (let dial = 0; dial < LASTING_REFUSALS_BEFORE_BLOCK; dial++) await w.dial()
    expect(w.outcomes).toEqual([...Array(LASTING_REFUSALS_BEFORE_BLOCK - 1).fill('dial-failed'), 'auth-blocked'])
    expect(w.authFailures()).toBe(1)
    // A retry starts the count again: one more refusal does not block at once.
    await w.dial()
    expect(w.outcomes.at(-1)).toBe('dial-failed')
  })

  test('a refusal that may pass never blocks', async () => {
    const w = await refusedTransport({ lasting: false, reason: 'http_503 (HTTP 503)' })
    for (let dial = 0; dial < LASTING_REFUSALS_BEFORE_BLOCK + 2; dial++) await w.dial()
    expect(w.outcomes.every((kind) => kind === 'dial-failed')).toBe(true)
    expect(w.authFailures()).toBe(0)
  })
})
