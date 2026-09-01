import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createLogger } from '../logger'

const log = createLogger('main', 'auth')

export const SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const CLAIM_OPEN_ADMIN_TTL_MS = 60 * 1000

interface ServerKeys {
  installationId: string
  signingKey: string
  /**
   * Persisted in server-keys.json with the signing material so ownership moves
   * with the server identity:
   *   "unclaimed" | { "owned": { "ownerDeviceId": "...", "claimedAt": 123 } }
   */
  ownership: OwnershipState
  [key: string]: unknown
}

interface PairToken {
  token: string
  /** 6-digit human-readable code derived from the token, for manual entry. */
  code: string
  expiresAt: number
}

export type OwnershipState = 'unclaimed' | { owned: { ownerDeviceId: string; claimedAt: number } }

export interface ClaimWindow {
  token: string
  /** 6-digit one-time claim code printed by the daemon/CLI. */
  code: string
  expiresAt: number
}

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
let _activeClaimWindow: ClaimWindow | null = null
const _revokedDevices = new Set<string>()
let _revokedDevicesLoaded = false

function loadOrCreateKeys(): ServerKeys {
  if (_keys) return _keys

  const dir = keysDir()
  const file = keysFile()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed?.installationId && parsed?.signingKey) {
        _keys = {
          ...parsed,
          ownership: normalizeOwnershipState(parsed.ownership),
        }
        return _keys!
      }
    } catch (err) {
      log.warn(`failed to load server keys, regenerating: ${err}`)
    }
  }

  _keys = {
    installationId: randomBytes(16).toString('hex'),
    signingKey: randomBytes(32).toString('hex'),
    ownership: 'unclaimed',
  }
  persistKeys()
  log.info(`created new server keys (installationId=${_keys.installationId.slice(0, 8)}…)`)
  return _keys!
}

export function getInstallationId(): string {
  return loadOrCreateKeys().installationId
}

export function getServerFingerprint(): string {
  return createHash('sha256').update(getInstallationId()).digest('hex').slice(0, 8)
}

export function getOwnershipState(): OwnershipState {
  return loadOrCreateKeys().ownership
}

export function createClaimOpenAdminSignature(signingKey: string, timestamp: string, nonce: string): string {
  return createHmac('sha256', signingKey).update(`claim-open:${timestamp}:${nonce}`).digest('hex')
}

export function verifyClaimOpenAdminRequest(
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
  if (Math.abs(now - issuedAt) > CLAIM_OPEN_ADMIN_TTL_MS) return false

  const expected = createClaimOpenAdminSignature(loadOrCreateKeys().signingKey, timestamp, nonce)
  const sigBuf = Buffer.from(signature, 'hex')
  const expBuf = Buffer.from(expected, 'hex')
  return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)
}

function singleHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000
export const CLAIM_WINDOW_TTL_MS = 10 * 60 * 1000

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
  if (entry.expiresAt < now) {
    _activePairTokens.delete(entry.token)
    _activePairTokens.delete(`code:${entry.code}`)
    return false
  }
  _activePairTokens.delete(entry.token)
  _activePairTokens.delete(`code:${entry.code}`)
  return true
}

export function openClaimWindow(options: { now?: number; ttlMs?: number } = {}): ClaimWindow | null {
  if (getOwnershipState() !== 'unclaimed') return null
  _activeClaimWindow = createOneTimeToken(options.ttlMs ?? CLAIM_WINDOW_TTL_MS, options.now ?? Date.now())
  return _activeClaimWindow
}

export function ensureClaimWindow(options: { now?: number; ttlMs?: number } = {}): ClaimWindow | null {
  if (getOwnershipState() !== 'unclaimed') return null
  const now = options.now ?? Date.now()
  if (_activeClaimWindow && _activeClaimWindow.expiresAt >= now) return _activeClaimWindow
  return openClaimWindow({ ...options, now })
}

export function getActiveClaimWindow(now = Date.now()): ClaimWindow | null {
  if (!_activeClaimWindow) return null
  if (_activeClaimWindow.expiresAt < now) {
    _activeClaimWindow = null
    return null
  }
  return _activeClaimWindow
}

export function isClaimable(now = Date.now()): boolean {
  return getOwnershipState() === 'unclaimed' && !!getActiveClaimWindow(now)
}

export type ClaimOwnershipResult =
  | { ok: true; sessionToken: string; ownerDeviceId: string; claimedAt: number; installationId: string; fingerprint: string }
  | { ok: false; reason: 'owned' | 'closed' }

export function claimOwnership(tokenOrCode: string, deviceLabel: string, now = Date.now()): ClaimOwnershipResult {
  const keys = loadOrCreateKeys()
  if (keys.ownership !== 'unclaimed') return { ok: false, reason: 'owned' }

  const claimWindow = getActiveClaimWindow(now)
  if (!claimWindow || (tokenOrCode !== claimWindow.token && tokenOrCode !== claimWindow.code)) {
    return { ok: false, reason: 'closed' }
  }

  _activeClaimWindow = null
  const sessionToken = issueSessionToken(deviceLabel, now)
  const session = verifySessionToken(sessionToken, now)
  if (!session) return { ok: false, reason: 'closed' }

  keys.ownership = { owned: { ownerDeviceId: session.deviceId, claimedAt: now } }
  persistKeys()

  return {
    ok: true,
    sessionToken,
    ownerDeviceId: session.deviceId,
    claimedAt: now,
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
export function issueSessionToken(deviceLabel: string, now = Date.now()): string {
  const deviceId = randomBytes(12).toString('hex')
  const issuedAt = now
  return signSessionToken(deviceId, deviceLabel, issuedAt)
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

export function revokeDevice(deviceId: string): void {
  loadRevokedDevices()
  _revokedDevices.add(deviceId)
  persistRevokedDevices()
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
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    const raw = Array.isArray(parsed) ? parsed : parsed?.deviceIds
    if (!Array.isArray(raw)) return
    for (const id of raw) {
      if (typeof id === 'string' && id) _revokedDevices.add(id)
    }
  } catch (err) {
    log.warn(`failed to load revoked devices: ${err}`)
  }
}

function persistRevokedDevices(): void {
  const dir = keysDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(revokedDevicesFile(), JSON.stringify({ version: 1, deviceIds: listRevokedDevices() }, null, 2), { mode: 0o600 })
}

export function resetAuthStateForTests(): void {
  _keys = null
  _activePairTokens.clear()
  _activeClaimWindow = null
  _revokedDevices.clear()
  _revokedDevicesLoaded = false
}

function normalizeOwnershipState(value: unknown): OwnershipState {
  if (value === 'unclaimed' || value == null) return 'unclaimed'
  if (!value || typeof value !== 'object') return 'unclaimed'
  const owned = (value as { owned?: unknown }).owned
  if (!owned || typeof owned !== 'object') return 'unclaimed'
  const candidate = owned as { ownerDeviceId?: unknown; claimedAt?: unknown }
  if (typeof candidate.ownerDeviceId !== 'string' || !candidate.ownerDeviceId) return 'unclaimed'
  if (typeof candidate.claimedAt !== 'number' || !Number.isFinite(candidate.claimedAt)) return 'unclaimed'
  return { owned: { ownerDeviceId: candidate.ownerDeviceId, claimedAt: candidate.claimedAt } }
}

function persistKeys(): void {
  const dir = keysDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(keysFile(), JSON.stringify(loadOrCreateKeys(), null, 2), { mode: 0o600 })
}

function keysDir(): string {
  return process.env.SOLUS_DATA_DIR || join(homedir(), '.solus')
}

function keysFile(): string {
  return join(keysDir(), 'server-keys.json')
}

function revokedDevicesFile(): string {
  return join(keysDir(), 'revoked-devices.json')
}
