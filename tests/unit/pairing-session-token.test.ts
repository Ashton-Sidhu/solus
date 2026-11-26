import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { closeDb, getDb } = await import('@solus/server/db')
const { INTERNAL_HANDLER_CTX, SolusServer } = await import('@solus/server/transport/server')
const { registerConnectionsHandlers } = await import('@solus/server/transport/handlers/connections-handlers')
const { isDeviceRevoked, issueSessionToken, listPairedDevices, refreshSessionToken, resetAuthStateForTests, revokeDevice, revokeSessionToken, SESSION_TOKEN_TTL_MS, verifySessionToken } = await import('@solus/server/admission/auth')

// plans/033 §2 rule 4 and §4.4: a host records the devices it paired in its
// database. A token is a random secret and the host keeps only its hash, so a
// token is good exactly while its row says so: revoked, idle too long, or gone
// with a wiped database, it is refused.

describe('a paired device', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    closeDb()
    dataDir = mkdtempSync(join(tmpdir(), 'solus-pairing-token-'))
    process.env.SOLUS_DATA_DIR = dataDir
    resetAuthStateForTests()
  })

  afterEach(() => {
    closeDb()
    resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('a device that pairs again revokes the token it replaces, so one device keeps one live row', () => {
    const replaced = issueSessionToken('Phone')
    const replacement = issueSessionToken('Phone')
    expect(revokeSessionToken(replaced.token)).toBe(true)
    expect(verifySessionToken(replaced.token)).toBeNull()
    expect(isDeviceRevoked(replaced.deviceId)).toBe(true)
    expect(verifySessionToken(replacement.token)?.deviceId).toBe(replacement.deviceId)
    expect(revokeSessionToken('a token no device has')).toBe(false)
  })

  test('pairing records the device with the hash of its token, never the token', () => {
    const now = Date.now()
    const { token, deviceId } = issueSessionToken('Laptop', now)
    expect(verifySessionToken(token, now)).toEqual({ deviceId, deviceLabel: 'Laptop', lastSeenAt: now })
    const row = getDb().prepare('SELECT kind, token_hash FROM host_device WHERE device_id = ?').get(deviceId)
    expect(row).toEqual({ kind: 'paired', token_hash: createHash('sha256').update(token).digest('hex') })
    expect(verifySessionToken(`${token}x`, now)).toBeNull()
  })

  test('a device that is not connected is still listed, with when it was last seen', () => {
    const now = Date.now()
    const { deviceId } = issueSessionToken('Phone', now - 5_000)
    expect(listPairedDevices()).toEqual([{ deviceId, deviceLabel: 'Phone', pairedAt: now - 5_000, lastSeenAt: now - 5_000, revokedAt: null }])
  })

  test('a token not used for thirty days is refused', () => {
    const now = Date.now()
    const { token } = issueSessionToken('Laptop', now)
    expect(verifySessionToken(token, now + SESSION_TOKEN_TTL_MS + 1)).toBeNull()
    expect(refreshSessionToken(token, now + SESSION_TOKEN_TTL_MS + 1)).toBeNull()
  })

  test('a refresh keeps the token and starts its thirty days again', () => {
    const now = Date.now()
    const { token, deviceId } = issueSessionToken('Phone', now)
    const later = now + SESSION_TOKEN_TTL_MS - 1_000
    expect(refreshSessionToken(token, later)).toBe(token)
    expect(listPairedDevices()[0]?.lastSeenAt).toBe(later)
    // Past thirty days from pairing, but not from the refresh.
    expect(verifySessionToken(token, now + SESSION_TOKEN_TTL_MS + 1_000)?.deviceId).toBe(deviceId)
  })

  test('a revoked device can neither verify nor refresh, and the list shows it revoked', () => {
    const { token, deviceId } = issueSessionToken('Phone')
    revokeDevice(deviceId)
    expect(isDeviceRevoked(deviceId)).toBe(true)
    expect(verifySessionToken(token)).toBeNull()
    expect(refreshSessionToken(token)).toBeNull()
    expect(listPairedDevices()[0]).toMatchObject({ deviceId, revokedAt: expect.any(Number) })
    // A restart reads the same rows.
    closeDb()
    resetAuthStateForTests()
    expect(verifySessionToken(token)).toBeNull()
  })

  test('an account grant or an acting host the owner revoked gets a row of its kind and stays out of the paired list', () => {
    expect(isDeviceRevoked('grant_web')).toBe(false)
    revokeDevice('grant_web')
    revokeDevice('host_box', 'host')
    expect(isDeviceRevoked('grant_web')).toBe(true)
    expect(isDeviceRevoked('host_box')).toBe(true)
    expect(getDb().prepare('SELECT device_id, kind FROM host_device ORDER BY device_id').all()).toEqual([
      { device_id: 'grant_web', kind: 'grant' },
      { device_id: 'host_box', kind: 'host' },
    ])
    expect(listPairedDevices()).toEqual([])
  })

  test('a token is refused once the database that recorded it is wiped', () => {
    const { token } = issueSessionToken('Laptop')
    expect(verifySessionToken(token)).not.toBeNull()
    closeDb()
    for (const file of ['solus.db', 'solus.db-wal', 'solus.db-shm']) rmSync(join(dataDir, file), { force: true })
    resetAuthStateForTests()
    expect(verifySessionToken(token)).toBeNull()
  })
})

describe('Sharing & access for the host', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-access-tab-'))
    process.env.SOLUS_DATA_DIR = dataDir
    resetAuthStateForTests()
  })

  afterEach(() => {
    resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('lists a paired device that is offline, and Revoke on a connected host acting for a person records a host', async () => {
    const server = new SolusServer()
    // SAFETY: the two methods under test read only the connected sessions.
    registerConnectionsHandlers(server, { getActiveSessions: () => [
      { id: 'socket-1', deviceLabel: 'Account', deviceId: 'host_box', isActingHost: true, connectedAt: 1 },
    ] } as never)
    const { deviceId } = issueSessionToken('Phone')
    expect((await server.handle('connectionsListDevices', [], INTERNAL_HANDLER_CTX)).map((device) => device.deviceId)).toEqual([deviceId])

    await server.handle('connectionsRevokeDevice', [{ deviceId: 'host_box' }], INTERNAL_HANDLER_CTX)
    await server.handle('connectionsRevokeDevice', [{ deviceId }], INTERNAL_HANDLER_CTX)
    expect(getDb().prepare('SELECT kind FROM host_device WHERE device_id = ?').get('host_box')).toEqual({ kind: 'host' })
    expect((await server.handle('connectionsListDevices', [], INTERNAL_HANDLER_CTX))[0]?.revokedAt).toEqual(expect.any(Number))
  })
})
