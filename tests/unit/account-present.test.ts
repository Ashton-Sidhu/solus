import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createServer } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { io, type Socket } from 'socket.io-client'
import type { TokenVerdict } from '@solus/server/admission/access-tokens'
import { WsTransport, GRANT_RENEWAL_LEAD_MS } from '@solus/client-core/ws-transport'
import { hostAudience, tokenEndpoint, type AccessTokenClaims } from '@solus/contracts/uplink'
import { clientCredential, generateHostKey } from '@solus/server/host/host-credential'
import { Delegations } from '@solus/server/sync/delegations'
import { LocalClientDoor } from '@solus/server/transport/local-client'
import { AccountReads } from '@solus/server/vault/account-reads'
import { VAULT_PATH } from '@solus/contracts/vault'
import type { HandshakeCredential } from '@solus/contracts/uplink'
import { handshake } from './helpers/socket-handshake'

// bun has no node:sqlite; the server modules' import chain reaches the db even though
// these tests never open it, so everything that reaches it loads after the seam.
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { issueSessionToken, resetAuthStateForTests } = await import('@solus/server/admission/auth')
const { createDoors } = await import('@solus/server/admission/doors')
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')
const { registerAuthHandlers } = await import('@solus/server/transport/handlers/auth-handlers')

// docs/adr/0001-standard-authentication.md §6 item 5: while any signed-in client of a
// person is connected to the host — by any route: account token, pairing, trusted
// network, loopback — the host holds a live delegation for that person and can read
// their account. A delegation stays bound to the grant that made it, so when that
// client signs out, the next presentation of another client makes it again.

const HOST_ID = 'abcdefghijklmnop'
const AUDIENCE = hostAudience(HOST_ID)
const ORIGIN = 'https://account.test'
const REGISTRATION = { hostId: HOST_ID, issuer: ORIGIN, jwksUrl: `${ORIGIN}/jwks`, directoryUrl: ORIGIN, generation: 1, apiUrl: 'https://api.test' }
const hostKey = await generateHostKey()
const credential = clientCredential({ clientId: `host_${HOST_ID}`, privateJwk: hostKey.privateJwk, tokenEndpoint: tokenEndpoint(ORIGIN) })

const cleanups: Array<() => void> = []
const originalDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-account-present-'))
  process.env.SOLUS_DATA_DIR = dataDir
  resetAuthStateForTests()
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  resetAuthStateForTests()
  rmSync(dataDir, { recursive: true, force: true })
  if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = originalDataDir
})

/** An unsigned JWT: the fake verifier below stands in for the signature check. */
function jwt(claims: Partial<AccessTokenClaims>): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: ORIGIN, aud: AUDIENCE, sub: 'alice', grant_id: 'grant_phone', client_id: 'solus-mobile',
    jti: crypto.randomUUID(), iat: now, exp: now + 300, access: 'owner', ...claims,
  }
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'ES256', kid: 'k1' })}.${part(payload)}.c2ln`
}

const claimsOf = (token: string): AccessTokenClaims => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))

/** The host's verifier: it accepts only a token for this host. */
async function verify(token: string): Promise<TokenVerdict> {
  const claims = claimsOf(token)
  return [claims.aud].flat().includes(AUDIENCE) ? { ok: true, claims } : { ok: false, reason: 'wrong-audience' }
}

/**
 * The account plane: it exchanges a person's token for a delegation unless the client
 * grant it names was revoked, and answers an account read made with a delegated token.
 */
function accountPlane() {
  const revokedGrants = new Set<string>()
  const exchanged: string[] = []
  const reads: Array<string | null> = []
  let issued = 0
  /** The delegation rows it keeps: the client grant each person's was made from. */
  const rows = new Map<string, string>()
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (String(url) === `${ORIGIN}/v1/hosts/${HOST_ID}/delegation-token`) {
      const grant = rows.get(JSON.parse(String(init?.body)).userId) ?? ''
      if (!grant) return Response.json({ error: 'no_delegation', solus_refusal: 'no_delegation' }, { status: 403 })
      if (revokedGrants.has(grant)) return Response.json({ error: 'grant_revoked', solus_refusal: 'grant_revoked' }, { status: 403 })
      issued += 1
      return Response.json({ access_token: `delegated-${grant}-${issued}`, expires_in: 3600 })
    }
    if (String(url) !== tokenEndpoint(ORIGIN)) {
      reads.push(new Headers(init?.headers).get('authorization'))
      return Response.json({ ok: true })
    }
    const form = init?.body as URLSearchParams
    const subject = form.get('subject_token') ?? ''
    const { sub, grant_id: grant } = claimsOf(subject)
    if (revokedGrants.has(grant ?? '')) return Response.json({ error: 'invalid_grant', solus_refusal: 'grant_revoked' }, { status: 400 })
    exchanged.push(subject)
    rows.set(sub, grant ?? '')
    issued += 1
    return Response.json({ access_token: `delegated-${grant}-${issued}`, expires_in: 3600 })
  }
  const delegations = new Delegations({ registration: () => REGISTRATION, credential: () => credential, controlToken: async () => 'control-token', onRevoked: () => {}, fetchImpl })
  cleanups.push(() => delegations.clear())
  return { delegations, fetchImpl, revokedGrants, exchanged, reads }
}

async function host(plane: ReturnType<typeof accountPlane>, options: { requireAuth?: boolean } = {}) {
  const verified: string[] = []
  const http = createServer((_request, response) => { response.writeHead(404).end() })
  const server = new SolusServer()
  registerAuthHandlers(server, {
    verify: (token) => { verified.push(token); return verify(token) },
    establish: (token, scope) => plane.delegations.establish(token, scope),
  })
  const transport = attachWebSocketTransport(http, server, { clientEvents: new ClientEventRegistry(), requireAuth: options.requireAuth ?? true, verifyAccessToken: verify, doors: createDoors({ place: 'host', verifyAccessToken: verify }) })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => transport.close())
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return { url: `http://127.0.0.1:${address.port}`, transport, verified }
}

function connect(url: string, credential: HandshakeCredential): Socket {
  const socket = io(url, { path: '/ws', transports: ['websocket'], reconnection: false, auth: handshake(credential) })
  cleanups.push(() => socket.disconnect())
  return socket
}

function call<T>(socket: Socket, method: string, args: unknown[]): Promise<{ result?: T; error?: { message: string } }> {
  return new Promise((resolve) => socket.emit('rpc', crypto.randomUUID(), method, args, resolve))
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const paired = (): HandshakeCredential => ({ kind: 'session-token', token: issueSessionToken('Phone').token })

describe('accountPresent on the host', () => {
  test("on a paired socket, the owner's token makes their personal delegation when none is held, and nothing again when it is; the socket stays local", async () => {
    const plane = accountPlane()
    const { url, transport } = await host(plane)
    const socket = connect(url, paired())
    await waitFor(() => socket.connected)

    const token = jwt({})
    expect((await call(socket, 'accountPresent', [{ accessToken: token }])).result).toEqual({ delegated: true })
    expect(plane.delegations.holders()).toEqual([{ userId: 'alice', scope: 'personal' }])
    expect(await call(socket, 'accountPresent', [{ accessToken: jwt({}) }])).toEqual({ result: { delegated: true } })
    expect(plane.exchanged).toEqual([token])
    // Local access stays as it was admitted (ADR 0001 rule 10).
    expect([...transport.sessions.values()].map((session) => session.principal.kind)).toEqual(['owner'])
  })

  test("a token for another host, a host's delegated token, and a token that names no scope here make no delegation", async () => {
    const plane = accountPlane()
    const { url } = await host(plane)
    const socket = connect(url, paired())
    await waitFor(() => socket.connected)

    const refused = [
      jwt({ aud: hostAudience('qrstuvwxyzabcdef') }),
      jwt({ aud: ['urn:solus:api', 'urn:solus:account'], act: { sub: 'host_other', host_id: 'other' }, access: 'owner' }),
      // A member names an organization to act in; with none named there is nothing to make.
      jwt({ sub: 'bob', grant_id: 'grant_bob', access: 'org-member', organizations: [{ id: 'org_a', role: 'member', teamIds: [] }] }),
    ]
    for (const token of refused) expect((await call(socket, 'accountPresent', [{ accessToken: token }])).result).toEqual({ delegated: false })
    expect(plane.exchanged).toEqual([])
    expect(plane.delegations.holders()).toEqual([])
  })

  test('authRenew makes again a delegation the host lost when another client signed out', async () => {
    const plane = accountPlane()
    const { url } = await host(plane)
    // The phone's grant made the delegation; then the phone signed out.
    await plane.delegations.establish(jwt({ grant_id: 'grant_phone' }), 'personal')
    plane.revokedGrants.add('grant_phone')
    plane.delegations.forgetGrant('grant_phone')
    expect(plane.delegations.holders()).toEqual([])

    // The web client is connected with its own account token.
    const socket = connect(url, { kind: 'access-token', token: jwt({ grant_id: 'grant_web' }) })
    await waitFor(() => socket.connected)
    const next = jwt({ grant_id: 'grant_web' })
    expect((await call<{ expiresAt: number }>(socket, 'authRenew', [{ accessToken: next }])).result?.expiresAt).toBeGreaterThan(Date.now())
    expect(plane.delegations.holders()).toEqual([{ userId: 'alice', scope: 'personal' }])
    expect(plane.exchanged.at(-1)).toBe(next)
  })
})

describe('accountPresent from the client transport', () => {
  test('a signed-in client on a credential-free route presents on connect, and again a little before the presented token ends', async () => {
    const plane = accountPlane()
    const { url, verified } = await host(plane, { requireAuth: false })
    const nowSeconds = Math.floor(Date.now() / 1000)
    // The first token ends just past the lead, so the next presentation is due at once.
    const tokens = [jwt({ exp: nowSeconds + GRANT_RENEWAL_LEAD_MS / 1000 + 1 }), jwt({ exp: nowSeconds + 600 })]
    let asked = 0
    const client = new WsTransport({ serverUrl: url, sessionToken: '', accountToken: async () => tokens[Math.min(asked++, 1)]! })
    cleanups.push(() => client.destroy())
    client.start()
    await waitFor(() => verified.length === 2)
    expect(verified).toEqual(tokens)
    expect(plane.delegations.holders()).toEqual([{ userId: 'alice', scope: 'personal' }])
  })

  test('a signed-out client, or one the account refused a token for, presents nothing and does not ask again', async () => {
    const plane = accountPlane()
    const { url, verified } = await host(plane, { requireAuth: false })
    let asked = 0
    const client = new WsTransport({ serverUrl: url, sessionToken: '', accountToken: async () => { asked += 1; return null } })
    cleanups.push(() => client.destroy())
    client.start()
    await waitFor(() => asked === 1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(asked).toBe(1)
    expect(verified).toEqual([])
  })
})

describe('the real sequence: a phone keeps the account reads alive after the desktop signs out', () => {
  test('desktop presents, the paired phone presents, the desktop signs out, and the phone’s next presentation makes the delegation again', async () => {
    const plane = accountPlane()
    const { url, verified } = await host(plane)
    const desktop = new LocalClientDoor({
      hostId: () => HOST_ID,
      needsRegistration: () => false,
      register: async () => {},
      verify,
      delegations: () => plane.delegations,
      organizationIds: () => [],
      onEstablished: () => {},
      onOwnerIdentity: () => {},
    })
    const desktopToken = jwt({ grant_id: 'grant_desktop', client_id: 'solus-desktop' })
    await desktop.presentToken(desktopToken)
    expect(plane.exchanged).toEqual([desktopToken])

    // The phone is paired: it never dials with its account token, but presents it.
    const nowSeconds = Math.floor(Date.now() / 1000)
    const phoneTokens = [jwt({ exp: nowSeconds + GRANT_RENEWAL_LEAD_MS / 1000 + 2 }), jwt({ exp: nowSeconds + 600 })]
    let asked = 0
    const phone = new WsTransport({ serverUrl: url, sessionToken: issueSessionToken('Phone').token, accountToken: async () => phoneTokens[Math.min(asked++, 1)]! })
    cleanups.push(() => phone.destroy())
    phone.start()
    await waitFor(() => verified.length === 1)
    // Held already, by the desktop's grant: nothing is exchanged.
    expect(plane.exchanged).toEqual([desktopToken])

    // The desktop signs out: its grant's delegation ends at once.
    plane.revokedGrants.add('grant_desktop')
    desktop.signedOut()
    expect(plane.delegations.holders()).toEqual([])
    const reads = new AccountReads({ origin: () => ORIGIN, delegations: () => plane.delegations, fetchImpl: plane.fetchImpl })
    expect(await reads.fetch('alice', null, VAULT_PATH, { method: 'POST' })).toMatchObject({ refused: 'NO_DELEGATION' })

    // The phone's next presentation makes it again, from the phone's grant.
    await waitFor(() => plane.delegations.has('alice', 'personal'))
    expect(plane.exchanged).toEqual([desktopToken, phoneTokens[1]])
    expect(await reads.fetch('alice', null, VAULT_PATH, { method: 'POST' })).toBeInstanceOf(Response)
    expect(plane.reads.at(-1)).toMatch(/^Bearer delegated-grant_phone-/)
  })
})
