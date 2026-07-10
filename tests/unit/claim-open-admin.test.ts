import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import type { Server } from 'http'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildHttpServer } from '../../src/main/server/http'
import * as auth from '../../src/main/server/auth'

const NOW = new Date('2026-03-01T00:00:00Z')

describe('claim-open admin endpoint', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-claim-open-test-'))
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

  test('opens a claim window when the local admin HMAC is valid', async () => {
    auth.getInstallationId()
    const { server, baseUrl } = await listen()
    try {
      expect(auth.getActiveClaimWindow()).toBeNull()
      const opened = await postJson(`${baseUrl}/claim/open`, null, adminHeaders())
      expect(opened.status).toBe(200)
      expect(opened.body.code).toMatch(/^\d{6}$/)
      expect(opened.body.fingerprint).toBe(auth.getServerFingerprint())
      expect(opened.body.endpoints).toEqual([
        { kind: 'loopback', label: 'Localhost', host: '127.0.0.1', port: expect.any(Number) },
      ])
      expect(auth.isClaimable()).toBe(true)
    } finally {
      await close(server)
    }
  })

  test('rejects missing, tampered, and expired admin HMACs without opening a claim window', async () => {
    auth.getInstallationId()
    const { server, baseUrl } = await listen()
    try {
      const missing = await postJson(`${baseUrl}/claim/open`, null, {})
      expect(missing.status).toBe(401)

      const tampered = await postJson(`${baseUrl}/claim/open`, null, {
        ...adminHeaders(),
        'x-solus-admin-signature': '0'.repeat(64),
      })
      expect(tampered.status).toBe(401)

      const expired = await postJson(`${baseUrl}/claim/open`, null, adminHeaders(Date.now() - auth.CLAIM_OPEN_ADMIN_TTL_MS - 1))
      expect(expired.status).toBe(401)
      expect(auth.isClaimable()).toBe(false)
    } finally {
      await close(server)
    }
  })

  test('does not reopen claim windows after ownership is claimed', async () => {
    const claimWindow = auth.openClaimWindow({ now: Date.now() })!
    const claimed = auth.claimOwnership(claimWindow.code, 'Owner laptop')
    expect(claimed.ok).toBe(true)

    const { server, baseUrl } = await listen()
    try {
      const reopened = await postJson(`${baseUrl}/claim/open`, null, adminHeaders())
      expect(reopened.status).toBe(403)
      expect(reopened.body.error).toBe('Server already claimed')
    } finally {
      await close(server)
    }
  })

  function adminHeaders(now = Date.now(), nonce = 'test-nonce'): Record<string, string> {
    const keys = JSON.parse(readFileSync(join(dataDir, 'server-keys.json'), 'utf-8')) as { signingKey: string }
    return {
      'x-solus-admin-timestamp': String(now),
      'x-solus-admin-nonce': nonce,
      'x-solus-admin-signature': auth.createClaimOpenAdminSignature(keys.signingKey, String(now), nonce),
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
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('test server did not bind to a TCP port'))
      else {
        port = address.port
        resolve()
      }
    })
  })
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
