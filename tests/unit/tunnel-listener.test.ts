import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

// bun has no node:sqlite; the http module's import chain reaches the db even
// though these tests never open it. Same seam health-auth-advertisement.test.ts uses.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { buildHttpServer } = await import('@solus/server/server/http')
type HttpServerOptions = NonNullable<Parameters<typeof buildHttpServer>[0]>
const auth = await import('@solus/server/server/auth')

// docs/plans/personal-uplink.md H3, the proxied-listener rule: `cloudflared` forwards
// the tunnel to loopback, and loopback is otherwise trusted. A request that arrived
// through the tunnel listener therefore gets no relaxation of any kind — not the open
// bind, not trusted-requester status, and no pairing door at all. And H1: the same
// `/auth/ws-ticket` accepts a verified grant.
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
      // The tunnel is a public URL: only the ticket door, the probe, and signed assets exist there.
      expect(health.body.name).toBeUndefined()
      expect(health.body.os).toBeUndefined()
      expect((await fetch(`${baseUrl}/upload`, { method: 'POST' })).status).toBe(404)
      expect((await fetch(`${baseUrl}/endpoints`)).status).toBe(404)
      expect((await fetch(`${baseUrl}/pair`, { method: 'POST', body: '{}' })).status).toBe(404)
      expect((await fetch(`${baseUrl}/pair/open`, { method: 'POST' })).status).toBe(404)
      expect((await fetch(`${baseUrl}/auth/ws-ticket`, { method: 'POST' })).status).toBe(401)
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

  test('/auth/ws-ticket accepts a verified grant and mints a grant ticket', async () => {
    const { server, baseUrl } = await listen({
      requireAuth: () => true,
      isTunnelRequest: () => true,
      verifyHostGrant: async (grant) => grant === 'good-grant'
        ? { ok: true, claims: { iss: 'https://app.example.test', aud: 'abcdefghijklmnop', sub: 'user_1', deviceId: 'session_1', jti: 'jti_1', iat: 1, exp: Math.floor(Date.now() / 1000) + 600 } }
        : { ok: false, reason: 'bad-signature' },
    })
    try {
      const refused = await fetch(`${baseUrl}/auth/ws-ticket`, { method: 'POST', headers: { authorization: 'Bearer bad-grant' } })
      expect(refused.status).toBe(401)
      const accepted = await fetch(`${baseUrl}/auth/ws-ticket`, { method: 'POST', headers: { authorization: 'Bearer good-grant' } })
      expect(accepted.status).toBe(200)
      const { ticket } = (await accepted.json()) as { ticket: string }
      const verified = auth.verifyWsTicket(ticket)
      expect(verified?.kind).toBe('grant')
      if (verified?.kind === 'grant') {
        expect(verified.userId).toBe('user_1')
        expect(verified.deviceId).toBe('session_1')
      }
    } finally {
      await close(server)
    }
  })

  test('a grant for a device the owner revoked on this host earns no ticket', async () => {
    // WHY: the Access tab's Revoke on a "Solus cloud" row is the host's own kill
    // switch; it must hold even though the control plane still signs grants.
    const { server, baseUrl } = await listen({
      requireAuth: () => true,
      isTunnelRequest: () => true,
      verifyHostGrant: async () => ({
        ok: true,
        claims: { iss: 'https://app.example.test', aud: 'abcdefghijklmnop', sub: 'user_1', deviceId: 'session_revoked', jti: 'jti_2', iat: 1, exp: Math.floor(Date.now() / 1000) + 600 },
      }),
    })
    try {
      auth.revokeDevice('session_revoked')
      const refused = await fetch(`${baseUrl}/auth/ws-ticket`, { method: 'POST', headers: { authorization: 'Bearer any' } })
      expect(refused.status).toBe(401)
    } finally {
      await close(server)
    }
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
