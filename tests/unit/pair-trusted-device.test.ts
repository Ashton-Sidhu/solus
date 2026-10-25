import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { buildHttpServer } = await import('@solus/server/transport/http')
const auth = await import('@solus/server/admission/auth')

const pairResponseSchema = z.object({
  sessionToken: z.string().optional(),
  installationId: z.string().optional(),
  error: z.string().optional(),
})

// "Trust my local network" promises that a device on the LAN joins without a
// pairing code. A native client still needs a credential of its own, so `/pair`
// with no code must issue one to a trusted device — and to nobody else.
describe('pairing without a code', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-pair-trusted-test-'))
    process.env.SOLUS_DATA_DIR = dataDir
    auth.resetAuthStateForTests()
  })

  afterEach(() => {
    auth.resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('a device the host trusts gets its own session token', async () => {
    const { server, baseUrl } = await listen({ trusted: true })
    try {
      const { status, body } = await pair(baseUrl)
      expect(status).toBe(200)
      expect(body.installationId).toBe(auth.getInstallationId())
      expect(auth.verifySessionToken(body.sessionToken ?? '')?.deviceLabel).toBe('Phone')
    } finally {
      await close(server)
    }
  })

  test('a device the host does not trust must bring a code', async () => {
    const { server, baseUrl } = await listen({ trusted: false })
    try {
      const { status, body } = await pair(baseUrl)
      expect(status).toBe(401)
      expect(body.sessionToken).toBeUndefined()
    } finally {
      await close(server)
    }
  })

  test('a tunnel caller is never trusted, whatever its address', async () => {
    const { server, baseUrl } = await listen({ trusted: true, viaTunnel: true })
    try {
      // The tunnel hides `/pair` entirely: pairing is local authorization.
      expect((await pair(baseUrl)).status).toBe(404)
    } finally {
      await close(server)
    }
  })
})

async function listen(opts: { trusted: boolean; viaTunnel?: boolean }): Promise<{ server: Server; baseUrl: string }> {
  let port = 0
  const { server } = buildHttpServer({
    host: '127.0.0.1',
    port: 0,
    getPort: () => port,
    requireAuth: () => true,
    isTrustedRequester: async () => opts.trusted,
    isTunnelRequest: () => opts.viaTunnel ?? false,
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = z.object({ port: z.number().int() }).safeParse(server.address())
      if (!address.success) reject(new Error('test server did not bind to a TCP port'))
      else {
        port = address.data.port
        resolve()
      }
    })
  })
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function pair(baseUrl: string): Promise<{ status: number; body: z.infer<typeof pairResponseSchema> }> {
  const response = await fetch(`${baseUrl}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceLabel: 'Phone' }),
  })
  return { status: response.status, body: pairResponseSchema.parse(await response.json()) }
}
