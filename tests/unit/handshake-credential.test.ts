import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createServer } from 'http'
import { Database } from 'bun:sqlite'
import { WsTransport } from '@solus/client-core/ws-transport'

// bun has no node:sqlite; the server modules' import chain reaches the db even though
// these tests never open it, so everything that reaches it loads after the seam.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { issueGrantWsTicket, resetAuthStateForTests } = await import('@solus/server/admission/auth')
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')

// docs/plans/instant-share-open.md: a dial presents its account token in the socket
// handshake, so it needs no ticket request (and no CORS preflight) first. The host
// admits it as its ticket door would, in the organization the dial names, and names
// its refusal; a host that predates this refuses it as plain `UNAUTHORIZED`, and the
// client asks that one for tickets.

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  resetAuthStateForTests()
})

/** A host. `admits` is its handshake admission; null for a host that predates it. Its ticket door admits any bearer. */
async function host(admits: ((bearer: string) => boolean) | null) {
  const exchanged: Array<[string, string | undefined]> = []
  const ticketRequests: string[] = []
  const http = createServer((request, response) => {
    if (request.url === '/auth/ws-ticket') ticketRequests.push(request.headers.authorization ?? '')
    const ticket = request.url === '/auth/ws-ticket' ? issueGrantWsTicket({ userId: 'user_1', deviceId: 'grant_1', expiresAt: Date.now() + 60_000 }) : null
    response.writeHead(ticket ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(ticket ? { ticket } : {}))
  })
  const transport = attachWebSocketTransport(http, new SolusServer(), {
    clientEvents: new ClientEventRegistry(),
    requireAuth: true,
    exchangeCredential: admits
      ? async (bearer, organizationId) => {
        exchanged.push([bearer, organizationId])
        return admits(bearer) ? issueGrantWsTicket({ userId: 'user_1', deviceId: 'grant_1', expiresAt: Date.now() + 60_000 }) : null
      }
      : undefined,
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => transport.close())
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return { url: `http://127.0.0.1:${address.port}`, exchanged, ticketRequests }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function dial(url: string, grants: { kept: string; fresh: string }, onAuthFailed = () => {}) {
  const statuses: string[] = []
  const transport = new WsTransport({
    serverUrl: url,
    sessionToken: '',
    acquireGrant: async (options) => (options?.fresh ? grants.fresh : grants.kept),
    dialOrganizationId: () => 'org_acme',
    onStatusChange: (status) => statuses.push(status),
    onAuthFailed,
  })
  cleanups.push(() => transport.destroy())
  transport.start()
  return { transport, statuses }
}

describe('the account token in the socket handshake', () => {
  test('a host that takes it admits the dial in the organization it names, with no ticket request', async () => {
    const server = await host(() => true)
    const { statuses } = dial(server.url, { kept: 'good', fresh: 'good' })
    await waitFor(() => statuses.includes('connected'))
    expect(server.exchanged).toEqual([['good', 'org_acme']])
    expect(server.ticketRequests).toEqual([])
  })

  test('a host that predates it is asked for a ticket, and the dial still opens', async () => {
    const server = await host(null)
    const { statuses } = dial(server.url, { kept: 'good', fresh: 'good' })
    await waitFor(() => statuses.includes('connected'))
    expect(server.ticketRequests).toEqual(['Bearer good'])
  })

  test('a kept token the host refuses is followed at once by a new one', async () => {
    const server = await host((bearer) => bearer === 'fresh')
    const { statuses } = dial(server.url, { kept: 'stale', fresh: 'fresh' })
    await waitFor(() => statuses.includes('connected'))
    expect(server.exchanged.map(([bearer]) => bearer)).toEqual(['stale', 'fresh'])
    expect(server.ticketRequests).toEqual([])
  })

  test('a new token the host also refuses blocks the host, as at the ticket door', async () => {
    const server = await host(() => false)
    let blocked = false
    const { statuses } = dial(server.url, { kept: 'stale', fresh: 'also-refused' }, () => { blocked = true })
    await waitFor(() => blocked)
    expect(statuses.at(-1)).toBe('blocked')
    expect(server.exchanged.map(([bearer]) => bearer)).toEqual(['stale', 'also-refused'])
  })
})
