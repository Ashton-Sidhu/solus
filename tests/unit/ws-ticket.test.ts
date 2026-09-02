import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  consumeWsTicket,
  isDeviceRevoked,
  issueGrantWsTicket,
  issueSessionToken,
  issueWsTicket,
  resetAuthStateForTests,
  revokeDevice,
  verifySessionToken,
  verifyWsTicket,
  WS_TICKET_TTL_MS,
} from '@solus/server/server/auth'

describe('WebSocket tickets', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-ws-ticket-test-'))
    process.env.SOLUS_DATA_DIR = dataDir
    resetAuthStateForTests()
  })

  afterEach(() => {
    resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('a valid session token exchanges for a ticket that carries its device', () => {
    const { token, deviceId } = issueSessionToken('Laptop')
    const ticket = issueWsTicket(token)
    expect(ticket).not.toBeNull()
    expect(verifyWsTicket(ticket!)?.deviceId).toBe(deviceId)
  })

  test('the two credentials live in separate signature domains', () => {
    // WHY: dispatch-client step 4 — a leaked five-minute ticket must never
    // pass where the thirty-day session token is expected, or the TTL is
    // theater. And the long-lived token must not open a socket as a ticket.
    const { token } = issueSessionToken('Laptop')
    const ticket = issueWsTicket(token)!
    expect(verifySessionToken(ticket)).toBeNull()
    expect(verifyWsTicket(token)).toBeNull()
  })

  test('a ticket expires on its own five-minute clock', () => {
    const { token } = issueSessionToken('Laptop')
    const now = Date.now()
    const ticket = issueWsTicket(token, now)!
    expect(verifyWsTicket(ticket, now + WS_TICKET_TTL_MS - 1)).not.toBeNull()
    expect(verifyWsTicket(ticket, now + WS_TICKET_TTL_MS + 1)).toBeNull()
  })

  test('an invalid or revoked credential earns no ticket', () => {
    expect(issueWsTicket('garbage')).toBeNull()
    const { token, deviceId } = issueSessionToken('Laptop')
    const ticket = issueWsTicket(token)!
    revokeDevice(deviceId)
    expect(verifyWsTicket(ticket)).toBeNull()
    expect(issueWsTicket(token)).toBeNull()
  })

  test('a ticket admits exactly one socket', () => {
    // WHY: docs/plans/personal-uplink.md H1 — a ticket captured in flight must not
    // open a second socket inside its five-minute window.
    const { token } = issueSessionToken('Laptop')
    const ticket = issueWsTicket(token)!
    expect(consumeWsTicket(ticket)).not.toBeNull()
    expect(consumeWsTicket(ticket)).toBeNull()
    // A fresh exchange is a fresh ticket.
    expect(consumeWsTicket(issueWsTicket(token)!)).not.toBeNull()
  })

  test('a ticket from before this process started is refused: a restart forgets what it spent', () => {
    // WHY: consumed tickets live in memory; without a floor a restart would let a
    // captured ticket admit a second socket inside its window.
    const { token } = issueSessionToken('Laptop')
    const ticket = issueWsTicket(token, Date.now() - 60_000)!
    expect(verifyWsTicket(ticket)).toBeNull()
  })

  test('revoking a device ends its cloud session too', () => {
    // WHY: the Access tab offers Revoke on a "Solus cloud" row; the grant's account
    // session id is what it revokes, so the next grant-ticket exchange must refuse it.
    const now = Date.now()
    const ticket = issueGrantWsTicket({ userId: 'user_1', deviceId: 'session_9', expiresAt: now + 30_000 }, now)
    expect(verifyWsTicket(ticket, now)).not.toBeNull()
    revokeDevice('session_9')
    expect(verifyWsTicket(ticket, now)).toBeNull()
    expect(isDeviceRevoked('session_9')).toBe(true)
  })

  test('a grant ticket carries the grant and dies with it, however young the ticket is', () => {
    const now = Date.now()
    const ticket = issueGrantWsTicket({ userId: 'user_1', deviceId: 'session_1', expiresAt: now + 30_000 }, now)
    const verified = verifyWsTicket(ticket, now)
    expect(verified?.kind).toBe('grant')
    if (verified?.kind === 'grant') {
      expect(verified.userId).toBe('user_1')
      expect(verified.deviceId).toBe('session_1')
    }
    expect(verifyWsTicket(ticket, now + 30_001)).toBeNull()
    // And it is never a session token either.
    expect(verifySessionToken(ticket)).toBeNull()
  })
})
