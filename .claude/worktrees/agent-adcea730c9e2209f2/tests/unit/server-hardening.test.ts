import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveEffectiveServerOptions } from '../../src/main/server/bind-policy'
import { createTokenBucketRateLimiter } from '../../src/main/server/rate-limit'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
  },
}))

const auth = await import('../../src/main/server/auth')

describe('server bind/auth coupling', () => {
  const originalHost = process.env.SOLUS_HOST

  afterEach(() => {
    if (originalHost === undefined) delete process.env.SOLUS_HOST
    else process.env.SOLUS_HOST = originalHost
  })

  test('defaults to loopback without auth when remote access is off', () => {
    delete process.env.SOLUS_HOST
    expect(resolveEffectiveServerOptions({ remoteAccess: false })).toEqual({
      host: '127.0.0.1',
      requireAuth: false,
    })
  })

  test('remote access binds all interfaces and forces auth', () => {
    delete process.env.SOLUS_HOST
    expect(resolveEffectiveServerOptions({ remoteAccess: true, requireAuth: false })).toEqual({
      host: '0.0.0.0',
      requireAuth: true,
    })
  })

  test('non-loopback env override forces auth even when opts disable it', () => {
    process.env.SOLUS_HOST = '192.168.1.40'
    expect(resolveEffectiveServerOptions({ remoteAccess: false, requireAuth: false })).toEqual({
      host: '192.168.1.40',
      requireAuth: true,
    })
  })
})

describe('session token lifetime, refresh, and revocation persistence', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  afterEach(() => {
    setSystemTime()
    auth.resetAuthStateForTests()
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  function isolateAuthStorage(): void {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-auth-test-'))
    process.env.SOLUS_DATA_DIR = dataDir
    auth.resetAuthStateForTests()
  }

  test('rejects tokens older than the 30 day session lifetime', () => {
    isolateAuthStorage()
    setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = auth.issueSessionToken('Test browser')

    setSystemTime(new Date('2026-02-01T00:00:01Z'))
    expect(Date.now() - Number(token.split('.')[1])).toBeGreaterThan(auth.SESSION_TOKEN_TTL_MS)
    expect(auth.verifySessionToken(token)).toBeNull()
  })

  test('refresh exchanges a valid token for a fresh token on the same device', () => {
    isolateAuthStorage()
    setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = auth.issueSessionToken('Test browser')
    const original = auth.verifySessionToken(token)!

    setSystemTime(new Date('2026-01-10T00:00:00Z'))
    const refreshed = auth.refreshSessionToken(token)
    expect(refreshed).toBeTruthy()
    const verified = auth.verifySessionToken(refreshed!)!
    expect(verified.deviceId).toBe(original.deviceId)
    expect(verified.deviceLabel).toBe('Test browser')
    expect(verified.issuedAt).toBe(Date.now())
  })

  test('revoked devices stay revoked after auth state reloads from disk', () => {
    isolateAuthStorage()
    setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = auth.issueSessionToken('Test browser')
    const session = auth.verifySessionToken(token)!

    auth.revokeDevice(session.deviceId)
    expect(auth.verifySessionToken(token)).toBeNull()

    auth.resetAuthStateForTests()
    expect(auth.verifySessionToken(token)).toBeNull()
  })
})

describe('pair route token bucket', () => {
  test('allows ten requests per key per minute, then refills after the window', () => {
    const limiter = createTokenBucketRateLimiter(10, 60_000)
    for (let i = 0; i < 10; i++) {
      expect(limiter.allow('192.168.1.5', 1_000)).toBe(true)
    }
    expect(limiter.allow('192.168.1.5', 1_000)).toBe(false)
    expect(limiter.allow('192.168.1.6', 1_000)).toBe(true)
    expect(limiter.allow('192.168.1.5', 61_001)).toBe(true)
  })
})
