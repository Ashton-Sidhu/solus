import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import { clearDelegation } from '../providers/github/delegation-store'

const log = createLogger('main', 'auth')

export const SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const PAIR_OPEN_ADMIN_TTL_MS = 60 * 1000

interface ServerKeys {
  installationId: string
  signingKey: string
}

interface PairToken {
  token: string
  /** 6-digit human-readable code derived from the token, for manual entry. */
  code: string
  expiresAt: number
}

const serverKeysSchema = z
  .object({
    installationId: z.string().min(1),
    signingKey: z.string().min(1),
  })
  .strict()

const revokedDevicesSchema = z.union([
  z.array(z.string().min(1)),
  z
    .object({
      version: z.number().optional(),
      deviceIds: z.array(z.string().min(1)),
    })
    .strict()
    .transform((value) => value.deviceIds),
])

interface SessionToken {
  /** Opaque random id used inside the signed token. */
  deviceId: string
  /** Human-readable label set during pairing, displayed in Connections panel. */
  deviceLabel: string
  /** Issuance timestamp (ms). */
  issuedAt: number
}

let _keys: ServerKeys | null = null
const _activePairTokens = new Map<string, PairToken>()
const _revokedDevices = new Set<string>()
let _revokedDevicesLoaded = false

function loadOrCreateKeys(): ServerKeys {
  if (_keys) return _keys

  const dir = solusDir()
  const file = keysFile()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, 'utf-8')
      const parsed = serverKeysSchema.safeParse(JSON.parse(raw))
      if (parsed.success) {
        _keys = parsed.data
        return _keys!
      }
    } catch (err) {
      log.warn('server_keys_load_failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  _keys = {
    installationId: randomBytes(16).toString('hex'),
    signingKey: randomBytes(32).toString('hex'),
  }
  persistKeys()
  log.info('server_keys_created', { installationId: _keys.installationId })
  return _keys!
}

export function getInstallationId(): string {
  return loadOrCreateKeys().installationId
}

export function getServerFingerprint(): string {
  return createHash('sha256').update(getInstallationId()).digest('hex').slice(0, 8)
}

export function createPairOpenAdminSignature(signingKey: string, timestamp: string, nonce: string): string {
  return createHmac('sha256', signingKey).update(`pair-open:${timestamp}:${nonce}`).digest('hex')
}

export function verifyPairOpenAdminRequest(
  headers: Record<string, string | string[] | undefined>,
  now = Date.now(),
): boolean {
  const timestamp = singleHeader(headers['x-solus-admin-timestamp'])
  const nonce = singleHeader(headers['x-solus-admin-nonce'])
  const signature = singleHeader(headers['x-solus-admin-signature'])
  if (!timestamp || !nonce || !signature) return false
  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) return false

  const issuedAt = Number(timestamp)
  if (!Number.isSafeInteger(issuedAt)) return false
  if (Math.abs(now - issuedAt) > PAIR_OPEN_ADMIN_TTL_MS) return false

  const expected = createPairOpenAdminSignature(loadOrCreateKeys().signingKey, timestamp, nonce)
  const sigBuf = Buffer.from(signature, 'hex')
  const expBuf = Buffer.from(expected, 'hex')
  return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)
}

function singleHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000

function createOneTimeToken(ttlMs: number, now: number): PairToken {
  const token = randomBytes(24).toString('base64url')
  // Derive a 6-digit code from the first bytes so users can read it.
  const codeNum = parseInt(token.replace(/[^0-9]/g, '').slice(0, 6) || '0', 10) % 1_000_000
  const code = codeNum.toString().padStart(6, '0')
  return { token, code, expiresAt: now + ttlMs }
}

/**
 * Generates a pair token + 6-digit code. Both refer to the same underlying
 * one-time-use credential; the 6-digit form is for manual entry, the full
 * token is embedded in the pairing link's URL fragment.
 */
export function generatePairToken(now = Date.now()): PairToken {
  const entry = createOneTimeToken(PAIR_TOKEN_TTL_MS, now)
  _activePairTokens.set(entry.token, entry)
  // Code-only lookup for manual entry.
  _activePairTokens.set(`code:${entry.code}`, entry)
  return entry
}

export function consumePairToken(tokenOrCode: string, now = Date.now()): boolean {
  const isCode = /^\d{6}$/.test(tokenOrCode)
  const key = isCode ? `code:${tokenOrCode}` : tokenOrCode
  const entry = _activePairTokens.get(key)
  if (!entry) return false
  _activePairTokens.delete(entry.token)
  _activePairTokens.delete(`code:${entry.code}`)
  return entry.expiresAt >= now
}

export interface SshBootstrapCredential {
  sessionToken: string
  installationId: string
  fingerprint: string
}

export function issueSshBootstrapCredential(deviceLabel: string, now = Date.now()): SshBootstrapCredential {
  const keys = loadOrCreateKeys()
  const { token: sessionToken } = issueSessionToken(deviceLabel, now)
  return {
    sessionToken,
    installationId: keys.installationId,
    fingerprint: getServerFingerprint(),
  }
}

function signSessionToken(deviceId: string, deviceLabel: string, issuedAt: number): string {
  const keys = loadOrCreateKeys()
  const labelB64 = Buffer.from(deviceLabel).toString('base64url')
  const payload = `${deviceId}.${issuedAt}.${labelB64}`
  const sig = createHmac('sha256', keys.signingKey).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/**
 * Signs an opaque session token: `<deviceId>.<issuedAt>.<deviceLabelB64>.<hmac>`.
 * The signing key never leaves the server; clients store the whole opaque blob.
 */
interface IssuedSessionToken {
  token: string
  deviceId: string
}

export function issueSessionToken(deviceLabel: string, now = Date.now()): IssuedSessionToken {
  const deviceId = randomBytes(12).toString('hex')
  const issuedAt = now
  return { token: signSessionToken(deviceId, deviceLabel, issuedAt), deviceId }
}

export function verifySessionToken(token: string, now = Date.now()): SessionToken | null {
  const keys = loadOrCreateKeys()
  loadRevokedDevices()
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [deviceId, issuedAtStr, labelB64, sig] = parts

  const issuedAt = Number(issuedAtStr)
  if (!Number.isFinite(issuedAt)) return null
  if (now - issuedAt > SESSION_TOKEN_TTL_MS) return null
  if (issuedAt > now + 60_000) return null

  const expected = createHmac('sha256', keys.signingKey).update(`${deviceId}.${issuedAtStr}.${labelB64}`).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null
  if (_revokedDevices.has(deviceId)) return null

  return {
    deviceId,
    deviceLabel: Buffer.from(labelB64, 'base64url').toString('utf-8'),
    issuedAt,
  }
}

export function refreshSessionToken(token: string, now = Date.now()): string | null {
  const session = verifySessionToken(token, now)
  if (!session) return null
  return signSessionToken(session.deviceId, session.deviceLabel, now)
}

/** Five minutes: long enough to open a socket, useless to a log scraper. */
export const WS_TICKET_TTL_MS = 5 * 60 * 1000

/** A `ws.`-prefixed signature domain: a leaked ticket can never pass where a
 *  session token is expected, and vice versa. */
const WS_TICKET_PREFIX = 'ws'

/** A ticket derived from a pairing session token: the caller is a local owner. */
export interface PairingWsTicket {
  kind: 'pairing'
  deviceId: string
  deviceLabel: string
  issuedAt: number
  /** One use: consumed at admission. */
  jti: string
}

/** A ticket derived from a control-plane grant: the owner arriving remotely. */
export interface GrantWsTicket {
  kind: 'grant'
  userId: string
  /** The account session the grant was minted for. */
  deviceId: string
  /** Grant expiry (ms); the ticket is worthless past it however young it is. */
  expiresAt: number
  issuedAt: number
  jti: string
}

export type VerifiedWsTicket = PairingWsTicket | GrantWsTicket

const wsTicketPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pairing'),
    deviceId: z.string().min(1),
    deviceLabel: z.string(),
    issuedAt: z.number(),
    jti: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('grant'),
    userId: z.string().min(1),
    deviceId: z.string().min(1),
    expiresAt: z.number(),
    issuedAt: z.number(),
    jti: z.string().min(1),
  }).strict(),
])

/** jti → the instant the ticket would have expired anyway. */
const _usedWsTickets = new Map<string, number>()
const PROCESS_STARTED_AT = Date.now()

function signWsTicket(payload: VerifiedWsTicket): string {
  const keys = loadOrCreateKeys()
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', keys.signingKey).update(`${WS_TICKET_PREFIX}.${body}`).digest('base64url')
  return `${WS_TICKET_PREFIX}.${body}.${sig}`
}

/**
 * A short-lived, single-purpose WebSocket ticket (dispatch-client step 4):
 * the long-lived session token only ever travels in HTTP headers, and only
 * this derived ticket rides the socket handshake.
 */
export function issueWsTicket(sessionToken: string, now = Date.now()): string | null {
  const session = verifySessionToken(sessionToken, now)
  if (!session) return null
  return signWsTicket({
    kind: 'pairing',
    deviceId: session.deviceId,
    deviceLabel: session.deviceLabel,
    issuedAt: now,
    jti: randomBytes(12).toString('hex'),
  })
}

export interface GrantTicketSubject {
  userId: string
  deviceId: string
  expiresAt: number
}

/** The same door for a verified control-plane grant (docs/plans/personal-uplink.md, H1). */
export function issueGrantWsTicket(grant: GrantTicketSubject, now = Date.now()): string {
  return signWsTicket({ kind: 'grant', ...grant, issuedAt: now, jti: randomBytes(12).toString('hex') })
}

/** Checks a ticket without spending it. Admission uses `consumeWsTicket`. */
export function verifyWsTicket(ticket: string, now = Date.now()): VerifiedWsTicket | null {
  const keys = loadOrCreateKeys()
  loadRevokedDevices()
  const parts = ticket.split('.')
  if (parts.length !== 3 || parts[0] !== WS_TICKET_PREFIX) return null
  const [, body, sig] = parts

  const expected = createHmac('sha256', keys.signingKey).update(`${WS_TICKET_PREFIX}.${body}`).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null

  let payload: VerifiedWsTicket
  try {
    payload = wsTicketPayloadSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')))
  } catch {
    return null
  }
  if (now - payload.issuedAt > WS_TICKET_TTL_MS) return null
  if (payload.issuedAt > now + 60_000) return null
  // Consumed tickets are remembered in memory only, so a ticket from before this
  // process started is refused outright: a restart must not reopen a spent one.
  if (payload.issuedAt < PROCESS_STARTED_AT) return null
  // Revoking a device on the Access tab ends both a paired device and a cloud session.
  if (_revokedDevices.has(payload.deviceId)) return null
  if (payload.kind === 'grant' && payload.expiresAt <= now) return null
  return payload
}

/** Whether the owner revoked this device (a paired device or an account session) on this host. */
export function isDeviceRevoked(deviceId: string): boolean {
  loadRevokedDevices()
  return _revokedDevices.has(deviceId)
}

/** Verifies a ticket and spends it: the same ticket admits exactly one socket. */
export function consumeWsTicket(ticket: string, now = Date.now()): VerifiedWsTicket | null {
  const verified = verifyWsTicket(ticket, now)
  if (!verified) return null
  for (const [jti, expiresAt] of _usedWsTickets) {
    if (expiresAt <= now) _usedWsTickets.delete(jti)
  }
  if (_usedWsTickets.has(verified.jti)) return null
  _usedWsTickets.set(verified.jti, verified.issuedAt + WS_TICKET_TTL_MS)
  return verified
}

export function revokeDevice(deviceId: string): void {
  loadRevokedDevices()
  _revokedDevices.add(deviceId)
  persistRevokedDevices()
  try {
    // Revocation must remain recorded even when secure credential cleanup fails.
    clearDelegation(deviceId)
  } catch (err) {
    log.warn('delegated_credential_clear_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function listRevokedDevices(): string[] {
  loadRevokedDevices()
  return [...new Set(_revokedDevices)]
}

function loadRevokedDevices(): void {
  if (_revokedDevicesLoaded) return
  _revokedDevicesLoaded = true
  const file = revokedDevicesFile()
  if (!existsSync(file)) return
  try {
    const parsed = revokedDevicesSchema.safeParse(JSON.parse(readFileSync(file, 'utf-8')))
    if (!parsed.success) return
    for (const deviceId of parsed.data) _revokedDevices.add(deviceId)
  } catch (err) {
    log.warn('revoked_devices_load_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

function persistRevokedDevices(): void {
  const dir = solusDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(revokedDevicesFile(), JSON.stringify({ version: 1, deviceIds: listRevokedDevices() }, null, 2), { mode: 0o600 })
}

export function resetAuthStateForTests(): void {
  _keys = null
  _activePairTokens.clear()
  _revokedDevices.clear()
  _revokedDevicesLoaded = false
  _usedWsTickets.clear()
}

function persistKeys(): void {
  const dir = solusDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(keysFile(), JSON.stringify(loadOrCreateKeys(), null, 2), { mode: 0o600 })
}

function keysFile(): string {
  return join(solusDir(), 'server-keys.json')
}

function revokedDevicesFile(): string {
  return join(solusDir(), 'revoked-devices.json')
}
