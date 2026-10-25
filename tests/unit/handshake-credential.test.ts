import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createServer } from 'http'
import { Server, type Socket } from 'socket.io'
import { socketHandshakeSchema, type HandshakeCredential } from '@solus/contracts/uplink'
import { WsTransport, type GrantSource } from '@solus/client-core/ws-transport'
import type { DialOutcome } from '@solus/client-core/host-supervisor'

// docs/plans/simplify-auth-and-sync.md §3 rule 4: a socket has one credential, in its
// handshake — an access token, a paired device's session token, or a guest's share
// secret with its id and name. No ticket request comes first, for anyone.

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

/** A host that admits a handshake as `admits` says, and records every handshake and HTTP request. */
async function host(admits: (credential: HandshakeCredential | undefined) => boolean = () => true) {
  const handshakes: unknown[] = []
  const httpRequests: string[] = []
  const http = createServer((request, response) => {
    httpRequests.push(request.url ?? '')
    response.writeHead(404).end()
  })
  const io = new Server(http, { path: '/ws', transports: ['websocket'] })
  io.use((socket: Socket, next) => {
    handshakes.push(socket.handshake.auth)
    const handshake = socketHandshakeSchema.safeParse(socket.handshake.auth)
    if (handshake.success && admits(handshake.data.credential)) return next()
    next(Object.assign(new Error('unauthorized'), { data: { code: 'UNAUTHORIZED' } }))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => { io.close(); http.close() })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return { url: `http://127.0.0.1:${address.port}`, handshakes, httpRequests }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function dial(url: string, credential: { sessionToken?: string; grants?: GrantSource; guest?: { shareSecret: string; guestId: string; displayName: string }; proveRoute?: () => Promise<boolean> }) {
  const outcomes: DialOutcome['kind'][] = []
  const statuses: string[] = []
  const transport = new WsTransport({
    serverUrl: url,
    sessionToken: credential.sessionToken ?? '',
    grants: credential.grants,
    guest: credential.guest,
    dialOrganizationId: credential.grants ? () => 'org_acme' : undefined,
    onStatusChange: (status) => statuses.push(status),
    onDialOutcome: (outcome) => outcomes.push(outcome.kind),
    proveRoute: credential.proveRoute,
  })
  cleanups.push(() => transport.destroy())
  spyOn(console, 'info').mockImplementation(() => {})
  transport.start()
  return { transport, outcomes, statuses }
}

describe('the one credential in the socket handshake', () => {
  test('an access token rides the handshake with the organization the dial names, and nothing else is asked first', async () => {
    const server = await host()
    const { outcomes } = dial(server.url, { grants: { acquire: async () => 'token-1', isSignedOut: () => false } })
    await waitFor(() => outcomes.includes('accepted'))
    expect(server.handshakes).toEqual([expect.objectContaining({ credential: { kind: 'access-token', token: 'token-1', organizationId: 'org_acme' } })])
    expect(server.httpRequests).toEqual([])
  })

  test('a paired device presents its session token', async () => {
    const server = await host()
    const { outcomes } = dial(server.url, { sessionToken: 'paired-1' })
    await waitFor(() => outcomes.includes('accepted'))
    expect(server.handshakes).toEqual([expect.objectContaining({ credential: { kind: 'session-token', token: 'paired-1' } })])
  })

  test('a guest presents the share secret with its id and name', async () => {
    const server = await host()
    const guest = { shareSecret: 'secret-1', guestId: 'guest_0123456789abcdef', displayName: 'Maya' }
    const { outcomes } = dial(server.url, { guest })
    await waitFor(() => outcomes.includes('accepted'))
    expect(server.handshakes).toEqual([expect.objectContaining({ credential: { kind: 'share-secret', secret: 'secret-1', guestId: guest.guestId, displayName: 'Maya' } })])
  })

  test('a refused share secret blocks the guest: the link was turned off', async () => {
    const server = await host(() => false)
    const { outcomes } = dial(server.url, { guest: { shareSecret: 'old', guestId: 'guest_0123456789abcdef', displayName: 'Maya' } })
    await waitFor(() => outcomes.includes('auth-blocked'))
    expect(server.handshakes).toHaveLength(1)
  })

  test('a token the host refuses blocks the host, and a retry asks the account for another one', async () => {
    // WHY: a kept host token can outlive the host's trust in it (the host was linked
    // again). The retry must not present the same token again.
    const server = await host((credential) => credential?.kind === 'access-token' && credential.token === 'fresh')
    const asked: Array<{ refused?: string } | undefined> = []
    let next = 'stale'
    const grants: GrantSource = { acquire: async (options) => { asked.push(options); return next }, isSignedOut: () => false }
    const { transport, outcomes } = dial(server.url, { grants })
    await waitFor(() => outcomes.includes('auth-blocked'))
    next = 'fresh'
    transport.start()
    await waitFor(() => outcomes.includes('accepted'))
    expect(asked).toEqual([undefined, { refused: 'stale' }])
  })
})

// A tab open for a long time outlives its sign-in. While the account holds none, the
// host is blocked as needing sign-in; the next sign-in dials it again.
describe('a host blocked while the account held no sign-in', () => {
  test('opens no socket, and connects when the person signs in again', async () => {
    const server = await host()
    let token: string | null = null
    const { transport, outcomes } = dial(server.url, { grants: { acquire: async () => token, isSignedOut: () => token === null } })
    await waitFor(() => outcomes.includes('auth-blocked'))
    expect(server.handshakes).toEqual([])
    token = 'good'
    transport.start()
    await waitFor(() => outcomes.includes('accepted'))
    expect(server.handshakes).toHaveLength(1)
  })
})

describe('the credential of a route that needs a proof of the host (docs/plans/host-routes.md D3)', () => {
  test('goes in the handshake once the host proved its identity key', async () => {
    const target = await host()
    dial(target.url, { sessionToken: 'session-1', proveRoute: async () => true })
    await waitFor(() => target.handshakes.length > 0)
    expect(target.handshakes[0]).toMatchObject({ credential: { kind: 'session-token', token: 'session-1' } })
  })

  test('is left out when the proof fails: whatever answers at the address never gets it', async () => {
    const target = await host()
    dial(target.url, { sessionToken: 'session-1', proveRoute: async () => false })
    await waitFor(() => target.handshakes.length > 0)
    expect(target.handshakes[0]).not.toHaveProperty('credential')
  })
})

describe('a token one host issued for another (an introduction or an SSH add)', () => {
  test('is sent as a session token, the kind the host admits it by', async () => {
    // WHY: a host refuses a session token sent as an access token; host-to-host dials
    // through a forward failed this way on a real machine.
    const target = await host()
    dial(target.url, { grants: { acquire: async () => 'session-from-b', isSignedOut: () => false, tokenKind: 'session-token' } })
    await waitFor(() => target.handshakes.length > 0)
    expect(target.handshakes[0]).toMatchObject({ credential: { kind: 'session-token', token: 'session-from-b' } })
  })
})
