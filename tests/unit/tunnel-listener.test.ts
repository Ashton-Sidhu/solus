import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from './helpers/bun-sqlite'

// bun has no node:sqlite; the http module's import chain reaches the db even
// though these tests never open it. Same seam health-auth-advertisement.test.ts uses.
mock.module('node:sqlite', () => ({ DatabaseSync }))

const { buildHttpServer } = await import('@solus/server/transport/http')
type HttpServerOptions = NonNullable<Parameters<typeof buildHttpServer>[0]>
const auth = await import('@solus/server/admission/auth')

// docs/plans/personal-uplink.md H3, the proxied-listener rule: `cloudflared` forwards
// the tunnel to loopback, and loopback is otherwise trusted. A request that arrived
// through the tunnel listener therefore gets no relaxation of any kind — not the open
// bind, not trusted-requester status, and no pairing door at all. And H1: a verified
// access token admits a socket (docs/plans/simplify-auth-and-sync.md §4.2).
describe('the tunnel listener', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-tunnel-listener-test-'))
    process.env.SOLUS_DATA_DIR = dataDir
    auth.resetAuthStateForTests()
  })

  afterEach(() => {
    auth.resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('an open, trusting host still demands a credential from tunnel callers and offers no pairing', async () => {
    const { server, baseUrl } = await listen({
      requireAuth: () => false,
      isTrustedRequester: async () => true,
      isTunnelRequest: () => true,
    })
    try {
      const health = await getJson(`${baseUrl}/health`)
      expect(health.body.requireAuth).toBe(true)
      // The tunnel is a public URL: only the probe, `/v1`, signed assets, and OAuth callbacks exist there.
      expect(health.body.name).toBeUndefined()
      expect(health.body.os).toBeUndefined()
      expect((await fetch(`${baseUrl}/upload`, { method: 'POST' })).status).toBe(404)
      expect((await fetch(`${baseUrl}/endpoints`)).status).toBe(404)
      expect((await fetch(`${baseUrl}/pair`, { method: 'POST', body: '{}' })).status).toBe(404)
      expect((await fetch(`${baseUrl}/pair/open`, { method: 'POST' })).status).toBe(404)
      // The ticket door is gone: the socket's handshake carries its credential.
      expect((await fetch(`${baseUrl}/auth/ws-ticket`, { method: 'POST' })).status).toBe(404)
    } finally {
      await close(server)
    }
  })

  // A sign-in started through the tunnel URL names that URL as its redirect, so the
  // browser comes back through the tunnel; a 404 there strands the sign-in.
  test('the OAuth callbacks are offered through the tunnel', async () => {
    const completeIntegrationOAuth = mock(async () => ({ status: 200 as const, html: 'connected' }))
    const { server, baseUrl } = await listen({ isTunnelRequest: () => true, completeIntegrationOAuth })
    try {
      const integration = await fetch(`${baseUrl}/oauth/integration/callback?state=s&code=c`)
      expect(integration.status).toBe(200)
      expect(completeIntegrationOAuth).toHaveBeenCalledTimes(1)
      expect((await fetch(`${baseUrl}/oauth/google/callback?state=s&code=c`)).status).not.toBe(404)
    } finally {
      await close(server)
    }
  })

  test('the same request on the ordinary listener keeps the ordinary policy', async () => {
    const { server, baseUrl } = await listen({
      requireAuth: () => false,
      isTrustedRequester: async () => true,
      isTunnelRequest: () => false,
    })
    try {
      const health = await getJson(`${baseUrl}/health`)
      expect(health.body.requireAuth).toBe(false)
      expect((await fetch(`${baseUrl}/pair`, { method: 'POST', body: '{}' })).status).not.toBe(404)
    } finally {
      await close(server)
    }
  })

  test("the server's doors admit a verified access token as the owner by grant", async () => {
    const { doors } = buildHttpServer({
      verifyAccessToken: async (token) => token === 'good-grant'
        ? { ok: true, claims: { iss: 'https://app.example.test', aud: 'abcdefghijklmnop', sub: 'user_1', grant_id: 'grant_1', access: 'owner', jti: 'jti_1', iat: 1, exp: Math.floor(Date.now() / 1000) + 300 } }
        : { ok: false, reason: 'bad-signature' },
    })
    expect(await doors.admitCredential({ kind: 'access-token', token: 'bad-grant' })).toEqual({ ok: false, reason: 'token-refused' })
    expect(await doors.admitCredential({ kind: 'access-token', token: 'good-grant' })).toMatchObject({ ok: true, principal: { kind: 'owner', via: 'grant', userId: 'user_1', deviceId: 'grant_1' } })
  })

  test('a client grant the owner revoked on this host is refused', async () => {
    // WHY: the Access tab's Revoke on a "Solus cloud" row is the host's own kill
    // switch; it must hold even though the control plane still signs grants.
    const { doors } = buildHttpServer({
      verifyAccessToken: async () => ({
        ok: true,
        claims: { iss: 'https://app.example.test', aud: 'abcdefghijklmnop', sub: 'user_1', grant_id: 'grant_revoked', access: 'owner', jti: 'jti_2', iat: 1, exp: Math.floor(Date.now() / 1000) + 300 },
      }),
    })
    auth.revokeDevice('grant_revoked')
    expect(await doors.admitCredential({ kind: 'access-token', token: 'any' })).toEqual({ ok: false, reason: 'device-revoked' })
  })
})

async function listen(options: HttpServerOptions): Promise<{ server: Server; baseUrl: string }> {
  const { server } = buildHttpServer({ ...options, host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address && 'port' in address ? address.port : 0
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function getJson(url: string): Promise<{ status: number; body: { requireAuth?: boolean; name?: string; os?: string } }> {
  const response = await fetch(url)
  return { status: response.status, body: (await response.json()) as { requireAuth?: boolean; name?: string; os?: string } }
}
