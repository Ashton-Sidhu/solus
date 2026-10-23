import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createServer } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { io, type Socket } from 'socket.io-client'
import { UPDATE_REQUIRED, type HandshakeCredential } from '@solus/contracts/uplink'
import type { ResolvedLinkShare } from '@solus/server/sharing/share-manager'
import { fakeAccessTokens, handshake } from './helpers/socket-handshake'

// bun has no node:sqlite; the server modules' import chain reaches the db even though
// these tests never open it, so everything that reaches it loads after the seam.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { issueSessionToken, resetAuthStateForTests, revokeDevice } = await import('@solus/server/admission/auth')
const { createDoors } = await import('@solus/server/admission/doors')
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')

// The host's side of docs/plans/simplify-auth-and-sync.md §3 rule 4, §4.6: a socket has
// one credential, in its handshake — an access token, a pairing session token, or a
// share secret with the guest's name — and the server builds the principal from it with
// nothing asked first. A client that does not speak the protocol is told to update.
// (The client's side is handshake-credential.test.ts.)

const SHARE: ResolvedLinkShare = { resource: { kind: 'session', id: 'session_1' }, role: 'viewer', sharedByUserId: 'host', linkSecretHash: 'hash_1', organizationId: 'local' }

const cleanups: Array<() => void> = []
let dataDir: string
const originalDataDir = process.env.SOLUS_DATA_DIR
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-socket-admission-'))
  process.env.SOLUS_DATA_DIR = dataDir
  resetAuthStateForTests()
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  resetAuthStateForTests()
  if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = originalDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

async function host() {
  const tokens = fakeAccessTokens()
  const httpRequests: string[] = []
  const http = createServer((request, response) => {
    httpRequests.push(request.url ?? '')
    response.writeHead(404).end()
  })
  const resolveShareSecret = async (secret: string) => secret === 'the-secret' ? SHARE : null
  const transport = attachWebSocketTransport(http, new SolusServer(), {
    clientEvents: new ClientEventRegistry(),
    requireAuth: true,
    doors: createDoors({ place: 'host', verifyAccessToken: tokens.verify, resolveShareSecret }),
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => transport.close())
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return { url: `http://127.0.0.1:${address.port}`, tokens, transport, httpRequests }
}

/** Dials once with this handshake; resolves with the connection or the refusal's message. */
function dial(url: string, auth: object): Promise<{ connected: true; socket: Socket } | { connected: false; message: string }> {
  const socket = io(url, { path: '/ws', transports: ['websocket'], reconnection: false, auth })
  cleanups.push(() => socket.disconnect())
  return new Promise((resolve) => {
    socket.once('connect', () => resolve({ connected: true, socket }))
    socket.once('connect_error', (error) => resolve({ connected: false, message: error.message }))
  })
}

const principals = (transport: { sessions: Map<string, { principal: object }> }) => [...transport.sessions.values()].map((session) => session.principal)

describe('a socket admits each credential from its handshake alone', () => {
  test("a person's access token admits its owner, with no HTTP request first", async () => {
    const server = await host()
    const token = server.tokens.mint({ sub: 'alice', grant_id: 'grant_web', displayName: 'Alice' })
    expect((await dial(server.url, handshake({ kind: 'access-token', token }))).connected).toBe(true)
    expect(principals(server.transport)).toEqual([expect.objectContaining({ kind: 'owner', via: 'grant', userId: 'alice', deviceId: 'grant_web', displayName: 'Alice' })])
    expect(server.httpRequests).toEqual([])
  })

  test("a member's token admits them in the organization the handshake names, and only one the token lists", async () => {
    const server = await host()
    const token = server.tokens.mint({ sub: 'bob', grant_id: 'grant_bob', access: 'org-member', organizations: [{ id: 'org_a', role: 'member', teamIds: ['t1'] }] })
    expect(await dial(server.url, handshake({ kind: 'access-token', token, organizationId: 'org_b' }))).toEqual({ connected: false, message: 'unauthorized' })
    expect((await dial(server.url, handshake({ kind: 'access-token', token, organizationId: 'org_a' }))).connected).toBe(true)
    expect(principals(server.transport)).toEqual([expect.objectContaining({ kind: 'org-member', userId: 'bob', organizationId: 'org_a', teamIds: ['t1'] })])
  })

  test("another host acting for the person, with this host's own audience, is admitted with its acting host as the device", async () => {
    const server = await host()
    const token = server.tokens.mint({ sub: 'alice', grant_id: 'grant_web', act: { sub: 'host_laptop', host_id: 'laptop' }, access: 'owner' })
    expect((await dial(server.url, handshake({ kind: 'access-token', token }))).connected).toBe(true)
    expect(principals(server.transport)).toEqual([expect.objectContaining({ kind: 'owner', via: 'grant', userId: 'alice', deviceId: 'laptop' })])
  })

  test('a pairing session token admits the local owner', async () => {
    const server = await host()
    const { token, deviceId } = issueSessionToken('Phone')
    expect((await dial(server.url, handshake({ kind: 'session-token', token }))).connected).toBe(true)
    expect(principals(server.transport)).toEqual([{ kind: 'owner', via: 'local', deviceId, deviceLabel: 'Phone', expiresAt: null }])
  })

  test("a share secret admits a guest bound to the link's one resource, named as they typed", async () => {
    const server = await host()
    const credential: HandshakeCredential = { kind: 'share-secret', secret: 'the-secret', guestId: 'maya-guest-0000001', displayName: 'Maya' }
    expect((await dial(server.url, handshake(credential))).connected).toBe(true)
    expect(principals(server.transport)).toEqual([expect.objectContaining({ kind: 'guest', guestId: 'maya-guest-0000001', displayName: 'Maya', share: expect.objectContaining({ resource: SHARE.resource, role: 'viewer' }) })])
    expect(await dial(server.url, handshake({ ...credential, secret: 'another-secret' }))).toEqual({ connected: false, message: 'unauthorized' })
  })

  test('a credential the host does not take is refused, never treated as no credential', async () => {
    const server = await host()
    expect(await dial(server.url, handshake({ kind: 'access-token', token: 'forged.token.here' }))).toEqual({ connected: false, message: 'unauthorized' })
    expect(await dial(server.url, handshake({ kind: 'session-token', token: 'forged.token' }))).toEqual({ connected: false, message: 'unauthorized' })
  })
})

describe('revocation on the Access tab holds at the handshake', () => {
  test('a revoked paired device, client grant, or acting host is refused', async () => {
    const server = await host()
    const paired = issueSessionToken('Phone')
    const person = server.tokens.mint({ sub: 'alice', grant_id: 'grant_web' })
    const acting = server.tokens.mint({ sub: 'alice', grant_id: 'grant_web2', act: { sub: 'host_laptop', host_id: 'laptop' }, access: 'owner' })
    revokeDevice(paired.deviceId)
    revokeDevice('grant_web')
    revokeDevice('laptop')
    expect(await dial(server.url, handshake({ kind: 'session-token', token: paired.token }))).toEqual({ connected: false, message: 'unauthorized' })
    expect(await dial(server.url, handshake({ kind: 'access-token', token: person }))).toEqual({ connected: false, message: 'unauthorized' })
    expect(await dial(server.url, handshake({ kind: 'access-token', token: acting }))).toEqual({ connected: false, message: 'unauthorized' })
  })
})

describe('a client that does not speak this protocol', () => {
  test('is told update_required, whether it sends no protocol, an old one, or an old ticket', async () => {
    const server = await host()
    const token = server.tokens.mint()
    for (const auth of [{}, { protocol: 1, credential: { kind: 'access-token', token } }, { ticket: 'ws.old.ticket' }, { accessToken: token }]) {
      expect(await dial(server.url, auth)).toEqual({ connected: false, message: UPDATE_REQUIRED })
    }
    expect(principals(server.transport)).toEqual([])
  })
})
