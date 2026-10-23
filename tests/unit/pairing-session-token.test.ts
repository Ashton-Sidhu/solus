import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isDeviceRevoked, issueSessionToken, refreshSessionToken, resetAuthStateForTests, revokeDevice, SESSION_TOKEN_TTL_MS, verifySessionToken } from '@solus/server/admission/auth'

// docs/plans/simplify-auth-and-sync.md §2, §4.2: LAN pairing stays. Its session token is
// signed by the shared signed-token code; the owner's Revoke on the Access tab ends it.

describe('a paired device session token', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-pairing-token-'))
    process.env.SOLUS_DATA_DIR = dataDir
    resetAuthStateForTests()
  })

  afterEach(() => {
    resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('names its device and label until it is thirty days old', () => {
    const now = Date.now()
    const { token, deviceId } = issueSessionToken('Laptop', now)
    expect(verifySessionToken(token, now)).toEqual({ deviceId, deviceLabel: 'Laptop', issuedAt: now })
    expect(verifySessionToken(token, now + SESSION_TOKEN_TTL_MS + 1)).toBeNull()
  })

  test('a changed payload or another host\'s key is refused', () => {
    const { token } = issueSessionToken('Laptop')
    const [payload, signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), deviceLabel: 'Mallory' })).toString('base64url')
    expect(verifySessionToken(`${forged}.${signature}`)).toBeNull()
    resetAuthStateForTests()
    rmSync(join(dataDir, 'server-keys.json'), { force: true })
    expect(verifySessionToken(token)).toBeNull()
  })

  test('a refresh renews the same device; a revoked device can neither verify nor refresh', () => {
    const { token, deviceId } = issueSessionToken('Phone')
    const refreshed = refreshSessionToken(token, Date.now() + 1000)
    expect(verifySessionToken(refreshed!)?.deviceId).toBe(deviceId)
    revokeDevice(deviceId)
    expect(isDeviceRevoked(deviceId)).toBe(true)
    expect(verifySessionToken(refreshed!)).toBeNull()
    expect(refreshSessionToken(token)).toBeNull()
  })

  test('revocation survives a restart in its one file format', () => {
    const { token, deviceId } = issueSessionToken('Phone')
    revokeDevice(deviceId)
    resetAuthStateForTests()
    expect(verifySessionToken(token)).toBeNull()
    // The legacy bare-array format is not read.
    writeFileSync(join(dataDir, 'revoked-devices.json'), JSON.stringify([deviceId]))
    resetAuthStateForTests()
    expect(isDeviceRevoked(deviceId)).toBe(false)
  })
})
