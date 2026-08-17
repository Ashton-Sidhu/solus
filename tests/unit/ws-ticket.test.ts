import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  issueSessionToken,
  issueWsTicket,
  resetAuthStateForTests,
  revokeDevice,
  verifySessionToken,
  verifyWsTicket,
  WS_TICKET_TTL_MS,
} from '../../src/main/server/auth'

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
})
