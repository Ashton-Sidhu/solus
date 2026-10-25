import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createServer } from 'http'
import { DatabaseSync } from './helpers/bun-sqlite'
import { io, type Socket } from 'socket.io-client'
import type { TokenVerdict } from '@solus/server/admission/access-tokens'
import { WsTransport, GRANT_RENEWAL_LEAD_MS, accessTokenEndsAt } from '@solus/client-core/ws-transport'
import { hostAudience, type AccessTokenClaims } from '@solus/contracts/uplink'
import { handshake } from './helpers/socket-handshake'

// bun has no node:sqlite; the server modules' import chain reaches the db even though
// these tests never open it, so everything that reaches it loads after the seam.
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { resetAuthStateForTests } = await import('@solus/server/admission/auth')
const { createDoors } = await import('@solus/server/admission/doors')
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')
const { registerAuthHandlers } = await import('@solus/server/transport/handlers/auth-handlers')

// docs/adr/0001-standard-authentication.md rule 4: a socket does not close when its
// token ends. The client sends the next token on the open socket (`authRenew`) a
// little before the end; the host moves the socket's end to it, and only to a token
// for the same person and audience. A token-free connection has nothing to renew.

const AUDIENCE = hostAudience('abcdefghijklmnop')
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  resetAuthStateForTests()
})

/** An unsigned JWT: the fake verifier below stands in for the signature check. */
function jwt(claims: Partial<AccessTokenClaims>): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: AccessTokenClaims = {
    iss: 'https://app.example.test', aud: AUDIENCE, sub: 'user_1', grant_id: 'grant_1', client_id: 'solus-desktop',
    jti: crypto.randomUUID(), iat: now, exp: now + 300, access: 'owner', ...claims,
  }
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'ES256', kid: 'k1' })}.${part(payload)}.c2ln`
}

/** Reads the token back, and refuses one for another audience, as the host's verifier does. */
async function verify(token: string): Promise<TokenVerdict> {
  const claims: AccessTokenClaims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
  return [claims.aud].flat().includes(AUDIENCE) ? { ok: true, claims } : { ok: false, reason: 'wrong-audience' }
}

async function host() {
  const http = createServer((_request, response) => { response.writeHead(404).end() })
  const server = new SolusServer()
  registerAuthHandlers(server)
  const transport = attachWebSocketTransport(http, server, {
    clientEvents: new ClientEventRegistry(),
    requireAuth: true,
    verifyAccessToken: verify,
    doors: createDoors({ place: 'host', verifyAccessToken: verify }),
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => transport.close())
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return { url: `http://127.0.0.1:${address.port}`, transport }
}

function renew(socket: Socket, accessToken: string): Promise<{ result?: { expiresAt: number }; error?: { message: string } }> {
  return new Promise((resolve) => socket.emit('rpc', crypto.randomUUID(), 'authRenew', [{ accessToken }], resolve))
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('authRenew on the host', () => {
  test('the next token of the same person keeps the socket open past the old end; another person or audience does not', async () => {
    const { url } = await host()
    const socket = io(url, { path: '/ws', transports: ['websocket'], reconnection: false, auth: handshake({ kind: 'access-token', token: jwt({ exp: (Date.now() + 400) / 1000 }) }) })
    cleanups.push(() => socket.disconnect())
    await waitFor(() => socket.connected)

    expect((await renew(socket, jwt({ sub: 'user_2' }))).error).toBeDefined()
    expect((await renew(socket, jwt({ aud: hostAudience('qrstuvwxyzabcdef') }))).error).toBeDefined()
    const next = jwt({})
    expect((await renew(socket, next)).result).toEqual({ expiresAt: accessTokenEndsAt(next)! })

    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(socket.connected).toBe(true)
  })

  test('a refused renewal leaves the old end in place', async () => {
    const { url } = await host()
    const socket = io(url, { path: '/ws', transports: ['websocket'], reconnection: false, auth: handshake({ kind: 'access-token', token: jwt({ exp: (Date.now() + 300) / 1000 }) }) })
    cleanups.push(() => socket.disconnect())
    await waitFor(() => socket.connected)
    expect((await renew(socket, jwt({ sub: 'user_2' }))).error).toBeDefined()
    await waitFor(() => !socket.connected)
  })
})

describe('authRenew from the client transport', () => {
  test('a little before the token ends, the transport sends the next one from the same grant source', async () => {
    const { url, transport } = await host()
    const nowSeconds = Math.floor(Date.now() / 1000)
    // The first token ends just past the renewal lead, so the renewal is due at once.
    const tokens = [jwt({ exp: nowSeconds + GRANT_RENEWAL_LEAD_MS / 1000 + 1 }), jwt({ exp: nowSeconds + 600 })]
    let acquired = 0
    const client = new WsTransport({ serverUrl: url, sessionToken: '', grants: { acquire: async () => tokens[Math.min(acquired++, 1)] ?? null, isSignedOut: () => false } })
    cleanups.push(() => client.destroy())
    client.start()
    const endOf = () => {
      const principal = [...transport.sessions.values()][0]?.principal
      return principal && 'expiresAt' in principal ? principal.expiresAt : null
    }
    await waitFor(() => endOf() === accessTokenEndsAt(tokens[1]!))
    expect(acquired).toBe(2)
  })
})
