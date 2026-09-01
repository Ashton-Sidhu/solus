import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import type { Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildHttpServer } from '../../src/main/server/http'
import * as auth from '../../src/main/server/auth'

const NOW = new Date('2026-03-01T00:00:00Z')

describe('claim state machine', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-claim-test-'))
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

  test('claims within an open window once, persists owner state, then rejects future claims', async () => {
    const claimWindow = auth.openClaimWindow({ now: Date.now() })!
    const { server, baseUrl } = await listen()
    try {
      const healthBefore = await getJson(`${baseUrl}/health`)
      expect(healthBefore.status).toBe(200)
      expect(healthBefore.body.claimable).toBe(true)

      const first = await postJson(`${baseUrl}/claim`, {
        code: claimWindow.code,
        deviceLabel: 'Owner laptop',
      })
      expect(first.status).toBe(200)
      expect(first.body.fingerprint).toBe(auth.getServerFingerprint())
      expect(first.body.ownerDeviceId).toBe(auth.verifySessionToken(first.body.sessionToken)!.deviceId)
      expect(auth.getOwnershipState()).toEqual({
        owned: {
          ownerDeviceId: first.body.ownerDeviceId,
          claimedAt: Date.now(),
        },
      })

      auth.resetAuthStateForTests()
      expect(auth.getOwnershipState()).toEqual({
        owned: {
          ownerDeviceId: first.body.ownerDeviceId,
          claimedAt: Date.now(),
        },
      })

      const second = await postJson(`${baseUrl}/claim`, {
        code: claimWindow.code,
        deviceLabel: 'Second owner',
      })
      expect(second.status).toBe(403)
      expect(second.body.error).toBe('Server already claimed')
    } finally {
      await close(server)
    }
  })

  test('rejects claims after the window TTL without taking ownership', async () => {
    const claimWindow = auth.openClaimWindow({ now: Date.now() })!
    setSystemTime(new Date(NOW.getTime() + auth.CLAIM_WINDOW_TTL_MS + 1))

    const { server, baseUrl } = await listen()
    try {
      const expired = await postJson(`${baseUrl}/claim`, {
        code: claimWindow.code,
        deviceLabel: 'Late owner',
      })
      expect(expired.status).toBe(403)
      expect(expired.body.error).toBe('Invalid or expired claim code')
      expect(auth.getOwnershipState()).toBe('unclaimed')

      const health = await getJson(`${baseUrl}/health`)
      expect(health.status).toBe(200)
      expect(health.body.claimable).toBe(false)
    } finally {
      await close(server)
    }
  })

  test('keeps the pair route available after ownership is claimed', async () => {
    const claimWindow = auth.openClaimWindow({ now: Date.now() })!
    const { server, baseUrl } = await listen()
    try {
      const claimed = await postJson(`${baseUrl}/claim`, {
        code: claimWindow.code,
        deviceLabel: 'Owner laptop',
      })
      expect(claimed.status).toBe(200)

      const pairToken = auth.generatePairToken(Date.now())
      const paired = await postJson(`${baseUrl}/pair`, {
        code: pairToken.code,
        deviceLabel: 'Browser',
      })
      expect(paired.status).toBe(200)
      expect(auth.verifySessionToken(paired.body.sessionToken)!.deviceLabel).toBe('Browser')
    } finally {
      await close(server)
    }
  })
})

async function listen(): Promise<{ server: Server; baseUrl: string }> {
  const { server } = buildHttpServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url)
  return { status: response.status, body: await response.json() }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
