import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import { closeDb, getDb } from '../db'
import { hostIdentity } from '../host/host-identity'
import { githubCredentials } from '../providers/github/credentials'
import type { AppAccess, PairedDevice } from '@solus/contracts/host-api'

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

let _keys: ServerKeys | null = null
const _activePairTokens = new Map<string, PairToken>()

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

/** A short form of the identity key a person can compare between the host and the device that pairs. */
export function getServerFingerprint(): string {
  return createHash('sha256').update(hostIdentity().publicKey()).digest('hex').slice(0, 8)
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
  identityKey: string
}

export function issueSshBootstrapCredential(deviceLabel: string, now = Date.now()): SshBootstrapCredential {
  const keys = loadOrCreateKeys()
  const { token: sessionToken } = issueSessionToken(deviceLabel, now)
  return {
    sessionToken,
    installationId: keys.installationId,
    fingerprint: getServerFingerprint(),
    identityKey: hostIdentity().publicKey(),
  }
}

interface IssuedSessionToken {
  token: string
  deviceId: string
}

/** A paired device as its token admits it. */
export interface PairedSession {
  deviceId: string
  deviceLabel: string
  /** When this host last admitted the token. It expires `SESSION_TOKEN_TTL_MS` after this. */
  lastSeenAt: number
}

/** `last_seen_at` is written at most this often for one device: a busy client does not write on every request. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000

const pairedRowSchema = z.object({
  device_id: z.string(),
  kind: z.string(),
  label: z.string(),
  paired_at: z.number(),
  last_seen_at: z.number(),
  revoked_at: z.number().nullable(),
})

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * A new paired device and its session token (plans/033 §4.4). The token is a
 * random secret; the host keeps only its hash, in the device's `host_device` row.
 */
export function issueSessionToken(deviceLabel: string, now = Date.now()): IssuedSessionToken {
  const deviceId = randomBytes(12).toString('hex')
  const token = randomBytes(32).toString('base64url')
  getDb().prepare(`INSERT INTO host_device (device_id, kind, label, token_hash, paired_at, last_seen_at)
    VALUES (?, 'paired', ?, ?, ?, ?)`).run(deviceId, deviceLabel, hashSessionToken(token), now, now)
  return { token, deviceId }
}

/** The paired device a session token names, or null when no row has its hash, the row is revoked, or the token was not used for `SESSION_TOKEN_TTL_MS`. */
export function verifySessionToken(token: string, now = Date.now()): PairedSession | null {
  if (!token) return null
  const db = getDb()
  const found = db.prepare(`SELECT device_id, kind, label, paired_at, last_seen_at, revoked_at FROM host_device
    WHERE token_hash = ? AND kind = 'paired'`).get(hashSessionToken(token))
  if (!found) return null
  const row = pairedRowSchema.parse(found)
  if (row.revoked_at !== null) return null
  if (now - row.last_seen_at > SESSION_TOKEN_TTL_MS) return null
  let lastSeenAt = row.last_seen_at
  if (now - lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
    db.prepare('UPDATE host_device SET last_seen_at = ? WHERE device_id = ?').run(now, row.device_id)
    lastSeenAt = now
  }
  return { deviceId: row.device_id, deviceLabel: row.label, lastSeenAt }
}

/** Revokes the paired device a session token names, whether or not the host still accepts it. False when no paired device has it. */
export function revokeSessionToken(token: string): boolean {
  const found = getDb().prepare(`SELECT device_id FROM host_device WHERE token_hash = ? AND kind = 'paired'`).get(hashSessionToken(token))
  if (!found) return false
  revokeDevice(z.object({ device_id: z.string() }).parse(found).device_id)
  return true
}

/** Renews a session token: the same token, seen now. Null when the host does not accept it. */
export function refreshSessionToken(token: string, now = Date.now()): string | null {
  const session = verifySessionToken(token, now)
  if (!session) return null
  if (session.lastSeenAt !== now) getDb().prepare('UPDATE host_device SET last_seen_at = ? WHERE device_id = ?').run(now, session.deviceId)
  return token
}

/** The devices and outside apps this host paired: the ones with access first, each group the most recently seen first. */
export function listPairedDevices(): PairedDevice[] {
  const rows = z.array(pairedRowSchema).parse(getDb().prepare(`SELECT device_id, kind, label, paired_at, last_seen_at, revoked_at
    FROM host_device WHERE kind = 'paired' OR kind LIKE 'app:%' ORDER BY revoked_at IS NOT NULL, last_seen_at DESC, device_id`).all())
  return rows.map((row) => {
    const device: PairedDevice = { deviceId: row.device_id, deviceLabel: row.label, pairedAt: row.paired_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at }
    const access = appAccessOfKind(row.kind)
    if (access) device.app = { access }
    return device
  })
}

/**
 * An outside app's grant: a row of its own kind, so its token is never a
 * device's session token (plans/035 §4.2). It is listed and revoked with the
 * paired devices, and kept while it is used, as a device's token is.
 */
const APP_KIND_PREFIX = 'app:'
const appAccessSchema = z.enum(['read', 'write', 'full'])

function appAccessOfKind(kind: string): AppAccess | null {
  if (!kind.startsWith(APP_KIND_PREFIX)) return null
  const access = appAccessSchema.safeParse(kind.slice(APP_KIND_PREFIX.length))
  return access.success ? access.data : null
}

export function issueAppToken(appLabel: string, access: AppAccess, now = Date.now()): IssuedSessionToken {
  const deviceId = randomBytes(12).toString('hex')
  const token = randomBytes(32).toString('base64url')
  getDb().prepare(`INSERT INTO host_device (device_id, kind, label, token_hash, paired_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(deviceId, `${APP_KIND_PREFIX}${access}`, appLabel, hashSessionToken(token), now, now)
  return { token, deviceId }
}

/** The outside app a token names, while it is not revoked and was used within `SESSION_TOKEN_TTL_MS`. */
export function verifyAppToken(token: string, now = Date.now()): (PairedSession & { access: AppAccess }) | null {
  if (!token) return null
  const db = getDb()
  const found = db.prepare(`SELECT device_id, kind, label, paired_at, last_seen_at, revoked_at FROM host_device
    WHERE token_hash = ? AND kind LIKE 'app:%'`).get(hashSessionToken(token))
  if (!found) return null
  const row = pairedRowSchema.parse(found)
  const access = appAccessOfKind(row.kind)
  if (!access || row.revoked_at !== null || now - row.last_seen_at > SESSION_TOKEN_TTL_MS) return null
  if (now - row.last_seen_at >= LAST_SEEN_WRITE_INTERVAL_MS) db.prepare('UPDATE host_device SET last_seen_at = ? WHERE device_id = ?').run(now, row.device_id)
  return { deviceId: row.device_id, deviceLabel: row.label, lastSeenAt: now, access }
}

/** Revokes the outside app a token names. False when no app has it. */
export function revokeAppToken(token: string): boolean {
  const found = getDb().prepare(`SELECT device_id FROM host_device WHERE token_hash = ? AND kind LIKE 'app:%'`).get(hashSessionToken(token))
  if (!found) return false
  revokeDevice(z.object({ device_id: z.string() }).parse(found).device_id)
  return true
}

/** Whether the owner revoked this device on this host: a paired device, an account grant, or an acting host. */
export function isDeviceRevoked(deviceId: string): boolean {
  return Boolean(getDb().prepare('SELECT 1 FROM host_device WHERE device_id = ? AND revoked_at IS NOT NULL').get(deviceId))
}

/**
 * Revokes a device on this host. A paired device's row is marked; an id with no
 * row (an account grant, or with `kind: 'host'` a host that acts for a person)
 * gets a revoked row of that kind, so its next token is refused too.
 */
export function revokeDevice(deviceId: string, kind: 'grant' | 'host' = 'grant', now = Date.now()): void {
  getDb().prepare(`INSERT INTO host_device (device_id, kind, revoked_at) VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET revoked_at = COALESCE(host_device.revoked_at, excluded.revoked_at)`).run(deviceId, kind, now)
  try {
    // Revocation must remain recorded even when secure credential cleanup fails.
    githubCredentials().revokeDelegation(deviceId)
  } catch (err) {
    log.warn('delegated_credential_clear_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** Forgets the keys and pair codes, and closes the database, so the next read uses the current `SOLUS_DATA_DIR`. */
export function resetAuthStateForTests(): void {
  _keys = null
  _activePairTokens.clear()
  closeDb()
}

function persistKeys(): void {
  const dir = solusDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(keysFile(), JSON.stringify(loadOrCreateKeys(), null, 2), { mode: 0o600 })
}

function keysFile(): string {
  return join(solusDir(), 'server-keys.json')
}
