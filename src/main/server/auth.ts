import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createLogger } from '../logger'

const log = createLogger('main', 'auth')

const KEYS_DIR = join(homedir(), '.solus')
const KEYS_FILE = join(KEYS_DIR, 'server-keys.json')

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

function loadOrCreateKeys(): ServerKeys {
  if (_keys) return _keys

  if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR, { recursive: true })

  if (existsSync(KEYS_FILE)) {
    try {
      const raw = readFileSync(KEYS_FILE, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed?.installationId && parsed?.signingKey) {
        _keys = parsed
        return _keys!
      }
    } catch (err) {
      log.warn(`failed to load server keys, regenerating: ${err}`)
    }
  }

  _keys = {
    installationId: randomBytes(16).toString('hex'),
    signingKey: randomBytes(32).toString('hex'),
  }
  writeFileSync(KEYS_FILE, JSON.stringify(_keys, null, 2), { mode: 0o600 })
  log.info(`created new server keys (installationId=${_keys.installationId.slice(0, 8)}…)`)
  return _keys!
}

export function getInstallationId(): string {
  return loadOrCreateKeys().installationId
}

const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000

/**
 * Generates a pair token + 6-digit code. Both refer to the same underlying
 * one-time-use credential; the 6-digit form is for manual entry, the full
 * token is embedded in the pairing link's URL fragment.
 */
export function generatePairToken(): PairToken {
  const token = randomBytes(24).toString('base64url')
  // Derive a 6-digit code from the first bytes so users can read it.
  const codeNum = parseInt(token.replace(/[^0-9]/g, '').slice(0, 6) || '0', 10) % 1_000_000
  const code = codeNum.toString().padStart(6, '0')
  const entry: PairToken = { token, code, expiresAt: Date.now() + PAIR_TOKEN_TTL_MS }
  _activePairTokens.set(token, entry)
  // Code-only lookup for manual entry.
  _activePairTokens.set(`code:${code}`, entry)
  return entry
}

export function consumePairToken(tokenOrCode: string): boolean {
  const isCode = /^\d{6}$/.test(tokenOrCode)
  const key = isCode ? `code:${tokenOrCode}` : tokenOrCode
  const entry = _activePairTokens.get(key)
  if (!entry) return false
  if (entry.expiresAt < Date.now()) {
    _activePairTokens.delete(entry.token)
    _activePairTokens.delete(`code:${entry.code}`)
    return false
  }
  _activePairTokens.delete(entry.token)
  _activePairTokens.delete(`code:${entry.code}`)
  return true
}

/**
 * Signs an opaque session token: `<deviceId>.<issuedAt>.<deviceLabelB64>.<hmac>`.
 * The signing key never leaves the server; clients store the whole opaque blob.
 */
export function issueSessionToken(deviceLabel: string): string {
  const keys = loadOrCreateKeys()
  const deviceId = randomBytes(12).toString('hex')
  const issuedAt = Date.now()
  const labelB64 = Buffer.from(deviceLabel).toString('base64url')
  const payload = `${deviceId}.${issuedAt}.${labelB64}`
  const sig = createHmac('sha256', keys.signingKey).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifySessionToken(token: string): SessionToken | null {
  const keys = loadOrCreateKeys()
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [deviceId, issuedAtStr, labelB64, sig] = parts

  const expected = createHmac('sha256', keys.signingKey).update(`${deviceId}.${issuedAtStr}.${labelB64}`).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null
  if (_revokedDevices.has(deviceId)) return null

  const issuedAt = Number(issuedAtStr)
  if (!Number.isFinite(issuedAt)) return null

  return {
    deviceId,
    deviceLabel: Buffer.from(labelB64, 'base64url').toString('utf-8'),
    issuedAt,
  }
}

export function revokeDevice(deviceId: string): void {
  _revokedDevices.add(deviceId)
}

export function listRevokedDevices(): string[] {
  return [...new Set(_revokedDevices)]
}
