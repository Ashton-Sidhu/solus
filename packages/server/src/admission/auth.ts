import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import { githubCredentials } from '../providers/github/credentials'
import { readSignedToken, signToken } from './signed-token'

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

const revokedDevicesSchema = z.object({ version: z.literal(1), deviceIds: z.array(z.string().min(1)) }).strict()

/**
 * A paired device's session token: signed with this host's key (`signed-token.ts`).
 * `purpose` keeps it apart from every other payload signed with the same code.
 */
const sessionTokenSchema = z.object({
  purpose: z.literal('pairing'),
  /** Opaque random id: what the Access tab lists and revokes. */
  deviceId: z.string().min(1),
  /** Human-readable label set during pairing, displayed in Connections panel. */
  deviceLabel: z.string(),
  /** Issuance timestamp (ms). */
  issuedAt: z.number().int(),
}).strict()
type SessionToken = Omit<z.infer<typeof sessionTokenSchema>, 'purpose'>

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
  return signToken<z.infer<typeof sessionTokenSchema>>({ purpose: 'pairing', deviceId, deviceLabel, issuedAt }, signingKey())
}

function signingKey(): Buffer {
  return Buffer.from(loadOrCreateKeys().signingKey, 'hex')
}

interface IssuedSessionToken {
  token: string
  deviceId: string
}

/** A new paired device's session token. The signing key never leaves the server; clients store the opaque token. */
export function issueSessionToken(deviceLabel: string, now = Date.now()): IssuedSessionToken {
  const deviceId = randomBytes(12).toString('hex')
  return { token: signSessionToken(deviceId, deviceLabel, now), deviceId }
}

/** The paired device a session token names, or null when it is forged, too old, from the future, or revoked. */
export function verifySessionToken(token: string, now = Date.now()): SessionToken | null {
  if (!token) return null
  const payload = readSignedToken(token, signingKey(), sessionTokenSchema)
  if (!payload) return null
  if (now - payload.issuedAt > SESSION_TOKEN_TTL_MS) return null
  if (payload.issuedAt > now + 60_000) return null
  if (isDeviceRevoked(payload.deviceId)) return null
  return { deviceId: payload.deviceId, deviceLabel: payload.deviceLabel, issuedAt: payload.issuedAt }
}

export function refreshSessionToken(token: string, now = Date.now()): string | null {
  const session = verifySessionToken(token, now)
  if (!session) return null
  return signSessionToken(session.deviceId, session.deviceLabel, now)
}

/** Whether the owner revoked this device (a paired device or an account session) on this host. */
export function isDeviceRevoked(deviceId: string): boolean {
  loadRevokedDevices()
  return _revokedDevices.has(deviceId)
}

export function revokeDevice(deviceId: string): void {
  loadRevokedDevices()
  _revokedDevices.add(deviceId)
  persistRevokedDevices()
  try {
    // Revocation must remain recorded even when secure credential cleanup fails.
    githubCredentials().revokeDelegation(deviceId)
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
    for (const deviceId of parsed.data.deviceIds) _revokedDevices.add(deviceId)
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
