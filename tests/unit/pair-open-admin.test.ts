import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { Server } from 'http'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { buildHttpServer } = await import('@solus/server/server/http')
const auth = await import('@solus/server/server/auth')

interface AdminHeaders {
  'x-solus-admin-timestamp': string
  'x-solus-admin-nonce': string
  'x-solus-admin-signature': string
}

const serverKeysSchema = z.object({ signingKey: z.string().min(1) })
const pairOpenResponseSchema = z.object({
  token: z.string().optional(),
  code: z.string().optional(),
  fingerprint: z.string().optional(),
})

const NOW = new Date('2026-03-01T00:00:00Z')

describe('pair-open admin endpoint', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-pair-open-test-'))
    process.env.SOLUS_DATA_DIR = dataDir
    auth.resetAuthStateForTests()
    setSystemTime(NOW)
  })

  afterEach(() => {
    setSystemTime()
    auth.resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('creates a pair token each time the local admin requests one', async () => {
    auth.getInstallationId()
    const { server, baseUrl } = await listen()
    try {
      const first = await post(`${baseUrl}/pair/open`, adminHeaders())
      const second = await post(`${baseUrl}/pair/open`, adminHeaders(Date.now(), 'second-nonce'))
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(first.body.token).not.toBe(second.body.token)
      expect(first.body.code).toMatch(/^\d{6}$/)
      expect(first.body.fingerprint).toBe(auth.getServerFingerprint())
    } finally {
      await close(server)
    }
  })

  test('rejects missing, tampered, and expired admin HMACs', async () => {
    auth.getInstallationId()
    const { server, baseUrl } = await listen()
    try {
      expect((await post(`${baseUrl}/pair/open`, {})).status).toBe(401)
      expect((await post(`${baseUrl}/pair/open`, {
        ...adminHeaders(),
        'x-solus-admin-signature': '0'.repeat(64),
      })).status).toBe(401)
      expect((await post(
        `${baseUrl}/pair/open`,
        adminHeaders(Date.now() - auth.PAIR_OPEN_ADMIN_TTL_MS - 1),
      )).status).toBe(401)
    } finally {
      await close(server)
    }
  })

  function adminHeaders(now = Date.now(), nonce = 'test-nonce'): AdminHeaders {
    const keys = serverKeysSchema.parse(JSON.parse(readFileSync(join(dataDir, 'server-keys.json'), 'utf-8')))
    return {
      'x-solus-admin-timestamp': String(now),
      'x-solus-admin-nonce': nonce,
      'x-solus-admin-signature': auth.createPairOpenAdminSignature(keys.signingKey, String(now), nonce),
    }
  }
})

async function listen(): Promise<{ server: Server; baseUrl: string }> {
  let port = 0
  const { server } = buildHttpServer({ host: '127.0.0.1', port: 0, getPort: () => port })
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

async function post(url: string, headers: Partial<AdminHeaders>): Promise<{ status: number; body: z.infer<typeof pairOpenResponseSchema> }> {
  const response = await fetch(url, { method: 'POST', headers })
  return { status: response.status, body: pairOpenResponseSchema.parse(await response.json()) }
}
