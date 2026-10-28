import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import type {
  WebhookSignatureFormat,
  WebhookTimestampCheck,
  WebhookValueSource,
  WebhookVerification,
  WebhookVerificationFailure,
} from '@solus/contracts/webhooks'
import type { FetchLike } from '../../admission/access-tokens'
import type { WebhookRequestData } from './request-data'

/**
 * Verification (docs/plans/webhooks.md §3.7): a check that a request comes from
 * the expected sender, in addition to the URL token. Generic schemes only; no
 * scheme names a sender. A failure names the step that failed, never a secret
 * or a computed signature.
 */

export type VerificationResult = { ok: true } | { ok: false; failure: WebhookVerificationFailure }

export interface VerificationContext {
  /** The secret bytes of `hmac`, `token`, and `standard_webhooks`; null when none is stored. */
  secret: Buffer | null
  /** The time a timestamp check compares with: the forwarder's proven receive time, else the arrival time (plan §2.5). */
  now: number
  fetchImpl?: FetchLike
}

const OK: VerificationResult = { ok: true }
const fail = (step: WebhookVerificationFailure['step'], detail?: string): VerificationResult =>
  ({ ok: false, failure: detail === undefined ? { step } : { step, detail } })

export async function verifyRequest(verification: WebhookVerification, data: WebhookRequestData, context: VerificationContext): Promise<VerificationResult> {
  switch (verification.scheme) {
    case 'none': return OK
    case 'hmac': return verifyHmac(verification, data, context)
    case 'public_key': return verifyPublicKey(verification, data, context)
    case 'token': return verifyToken(verification, data, context)
    case 'jwt': {
      const [token] = readSource(verification.source, data)
      if (!token) return fail('value_missing', sourceName(verification.source))
      return verifyJwt(token, verification, context)
    }
    case 'standard_webhooks': return verifyStandardWebhook(data, context)
  }
}

function verifyHmac(verification: Extract<WebhookVerification, { scheme: 'hmac' }>, data: WebhookRequestData, context: VerificationContext): VerificationResult {
  if (!context.secret) return fail('secret_missing')
  const timestamp = checkTimestamp(verification.timestamp, data, context.now)
  if (timestamp) return timestamp
  const signatures = signatureCandidates(verification.signature.source, verification.signature.format, data)
  if (!signatures.length) return fail('value_missing', sourceName(verification.signature.source))
  const signed = renderSignedText(verification.signedText, data)
  if (!signed) return fail('value_missing', 'signed text')
  const expected = createHmac(verification.algorithm, context.secret).update(signed).digest()
  return signatures.some((candidate) => safeEqual(candidate, expected)) ? OK : fail('signature_mismatch')
}

function verifyPublicKey(verification: Extract<WebhookVerification, { scheme: 'public_key' }>, data: WebhookRequestData, context: VerificationContext): VerificationResult {
  const timestamp = checkTimestamp(verification.timestamp, data, context.now)
  if (timestamp) return timestamp
  const signatures = signatureCandidates(verification.signature.source, verification.signature.format, data)
  if (!signatures.length) return fail('value_missing', sourceName(verification.signature.source))
  const signed = renderSignedText(verification.signedText, data)
  if (!signed) return fail('value_missing', 'signed text')
  let key: KeyObject
  try {
    key = publicKeyOf(verification.algorithm, verification.publicKey)
  } catch {
    return fail('keys_unavailable')
  }
  return signatures.some((signature) => publicKeyMatches(verification.algorithm, key, signed, signature)) ? OK : fail('signature_mismatch')
}

function verifyToken(verification: Extract<WebhookVerification, { scheme: 'token' }>, data: WebhookRequestData, context: VerificationContext): VerificationResult {
  const secret = context.secret
  if (!secret) return fail('secret_missing')
  const values = readSource(verification.source, data)
  if (!values.length) return fail('value_missing', sourceName(verification.source))
  return values.some((value) => safeEqual(Buffer.from(value, 'utf8'), secret)) ? OK : fail('signature_mismatch')
}

// ─── Value sources ───

export function sourceName(source: WebhookValueSource): string {
  if (source.kind === 'bearer') return 'authorization'
  return source.kind === 'header' ? source.name.toLowerCase() : `${source.name.toLowerCase()}|${source.key}`
}

/** One header's `key=value` parts with this key. A header can hold the same key more than once (`v1=…,v1=…`). */
function headerParts(header: string, key: string, separator: string): string[] {
  const values: string[] = []
  for (const part of header.split(separator)) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === key) values.push(part.slice(index + 1).trim())
  }
  return values
}

export function readSource(source: WebhookValueSource, data: WebhookRequestData): string[] {
  if (source.kind === 'bearer') {
    const match = /^Bearer\s+(.+)$/i.exec(data.headers.get('authorization') ?? '')
    return match ? [match[1].trim()] : []
  }
  const header = data.headers.get(source.name.toLowerCase())
  if (header === undefined || header === '') return []
  return source.kind === 'header' ? [header] : headerParts(header, source.key, source.separator)
}

function decodeSignature(value: string, encoding: WebhookSignatureFormat['encoding']): Buffer | null {
  const text = value.trim()
  if (encoding === 'hex') return /^(?:[0-9a-f]{2})+$/i.test(text) ? Buffer.from(text, 'hex') : null
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** Every signature the request offers, decoded; a value without the prefix is not a signature. */
function signatureCandidates(source: WebhookValueSource, format: WebhookSignatureFormat, data: WebhookRequestData): Buffer[] {
  const candidates: Buffer[] = []
  for (const value of readSource(source, data)) {
    const items = format.listSeparator ? value.split(format.listSeparator) : [value]
    for (const raw of items) {
      let item = raw.trim()
      if (format.prefix) {
        if (!item.startsWith(format.prefix)) continue
        item = item.slice(format.prefix.length)
      }
      const decoded = decodeSignature(item, format.encoding)
      if (decoded?.length) candidates.push(decoded)
    }
  }
  return candidates
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

// ─── Signed text ───

const SIGNED_PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g

/**
 * The signed text as bytes: `{{body}}` is the raw body; `{{headers.name}}` is a
 * header; `{{headers.name|key}}` is one part of a header (`,` or `;` separated).
 * Null when a placeholder has no value.
 */
export function renderSignedText(template: string, data: WebhookRequestData): Buffer | null {
  const chunks: Buffer[] = []
  let last = 0
  for (const match of template.matchAll(SIGNED_PLACEHOLDER)) {
    chunks.push(Buffer.from(template.slice(last, match.index), 'utf8'))
    last = match.index + match[0].length
    const value = signedValue(match[1], data)
    if (value === null) return null
    chunks.push(value)
  }
  chunks.push(Buffer.from(template.slice(last), 'utf8'))
  return Buffer.concat(chunks)
}

function signedValue(path: string, data: WebhookRequestData): Buffer | null {
  if (path === 'body') return data.rawBody
  const [root, ...rest] = path.split('.')
  const name = rest.join('.')
  if (root === 'query') {
    const value = data.query.get(name)
    return value === undefined ? null : Buffer.from(value, 'utf8')
  }
  if (root !== 'headers') return null
  const [header, key] = name.split('|')
  const value = data.headers.get(header.toLowerCase())
  if (value === undefined) return null
  if (key === undefined) return Buffer.from(value, 'utf8')
  const parts = [...headerParts(value, key, ','), ...(value.includes(';') ? headerParts(value, key, ';') : [])]
  return parts.length ? Buffer.from(parts[0], 'utf8') : null
}

// ─── Timestamps ───

/** Unix seconds, Unix milliseconds, or an ISO time, as epoch milliseconds. */
export function parseTimestamp(value: string): number | null {
  const text = value.trim()
  if (/^\d+(\.\d+)?$/.test(text)) {
    const number = Number(text)
    return number > 1e12 ? number : number * 1000
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function checkTimestamp(check: WebhookTimestampCheck | undefined, data: WebhookRequestData, now: number): VerificationResult | null {
  if (!check) return null
  const [value] = readSource(check.source, data)
  if (value === undefined) return fail('value_missing', sourceName(check.source))
  const at = parseTimestamp(value)
  if (at === null || Math.abs(now - at) > check.toleranceSeconds * 1000) return fail('timestamp_outside_tolerance')
  return null
}

// ─── Public keys ───

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function keyBytes(text: string): Buffer {
  const trimmed = text.trim()
  if (/^(?:[0-9a-f]{2})+$/i.test(trimmed)) return Buffer.from(trimmed, 'hex')
  return Buffer.from(trimmed, 'base64')
}

/** A public key from PEM, or from hex or base64 of a raw key or an SPKI DER key. */
export function publicKeyOf(algorithm: 'ed25519' | 'ecdsa-p256', text: string): KeyObject {
  if (text.includes('-----BEGIN')) return createPublicKey(text)
  const bytes = keyBytes(text)
  if (algorithm === 'ed25519' && bytes.length === 32) {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]), format: 'der', type: 'spki' })
  }
  if (algorithm === 'ecdsa-p256' && bytes.length === 65 && bytes[0] === 4) {
    return createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33).toString('base64url') },
      format: 'jwk',
    })
  }
  return createPublicKey({ key: bytes, format: 'der', type: 'spki' })
}

function publicKeyMatches(algorithm: 'ed25519' | 'ecdsa-p256', key: KeyObject, signed: Buffer, signature: Buffer): boolean {
  try {
    if (algorithm === 'ed25519') return verifySignature(null, signed, key, signature)
    return verifySignature('sha256', signed, { key, dsaEncoding: signature.length === 64 ? 'ieee-p1363' : 'der' }, signature)
  } catch {
    return false
  }
}

// ─── Standard Webhooks (https://www.standardwebhooks.com) ───

const STANDARD_WEBHOOKS_TOLERANCE_MS = 5 * 60 * 1000

function verifyStandardWebhook(data: WebhookRequestData, context: VerificationContext): VerificationResult {
  if (!context.secret) return fail('secret_missing')
  const id = data.headers.get('webhook-id')
  const timestamp = data.headers.get('webhook-timestamp')
  const signatures = data.headers.get('webhook-signature')
  if (!id) return fail('value_missing', 'webhook-id')
  if (!timestamp) return fail('value_missing', 'webhook-timestamp')
  if (!signatures) return fail('value_missing', 'webhook-signature')
  const at = parseTimestamp(timestamp)
  if (at === null || Math.abs(context.now - at) > STANDARD_WEBHOOKS_TOLERANCE_MS) return fail('timestamp_outside_tolerance')
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), data.rawBody])
  const expected = createHmac('sha256', context.secret).update(signed).digest()
  for (const entry of signatures.split(' ')) {
    const [version, value] = entry.split(',')
    if (version !== 'v1' || !value) continue
    const decoded = decodeSignature(value, 'base64')
    if (decoded && safeEqual(decoded, expected)) return OK
  }
  return fail('signature_mismatch')
}

/** A Standard Webhooks secret is `whsec_` and base64; the bytes after the prefix are the key. */
export function decodeStandardWebhooksSecret(secret: string): Buffer {
  return Buffer.from(secret.trim().replace(/^whsec_/, ''), 'base64')
}

// ─── JWT ───

const JWKS_REFRESH_MIN_INTERVAL_MS = 60_000
const JWT_CLOCK_SKEW_MS = 60_000

const jwtHeaderSchema = z.object({ alg: z.enum(['RS256', 'ES256', 'EdDSA']), kid: z.string().optional() })
const jwtClaimsSchema = z.object({
  iss: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  exp: z.number().optional(),
  nbf: z.number().optional(),
})
const jwkSchema = z.object({ kid: z.string().optional(), kty: z.string(), alg: z.string().optional() }).loose()
const jwksSchema = z.object({ keys: z.array(z.unknown()) })

interface JwksCache {
  keys: { kid: string | undefined; key: KeyObject }[]
  refreshedAt: number
  inFlight: Promise<void> | null
}

/** One key cache for each JWKS URL, as `admission/access-tokens.ts` keeps one: an unknown key refreshes at most once a minute. */
const jwksCaches = new Map<string, JwksCache>()

async function keysFor(url: string, kid: string | undefined, now: number, fetchImpl: FetchLike): Promise<KeyObject[]> {
  let cache = jwksCaches.get(url)
  if (!cache) {
    cache = { keys: [], refreshedAt: 0, inFlight: null }
    jwksCaches.set(url, cache)
  }
  const matching = () => cache!.keys.filter((entry) => kid === undefined || entry.kid === kid).map((entry) => entry.key)
  if (matching().length) return matching()
  if (cache.refreshedAt === 0 || now - cache.refreshedAt >= JWKS_REFRESH_MIN_INTERVAL_MS) {
    cache.inFlight ??= refreshJwks(url, cache, now, fetchImpl).finally(() => { cache!.inFlight = null })
    await cache.inFlight
  }
  return matching()
}

async function refreshJwks(url: string, cache: JwksCache, now: number, fetchImpl: FetchLike): Promise<void> {
  cache.refreshedAt = now
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return
    const body = jwksSchema.parse(await response.json())
    const keys: JwksCache['keys'] = []
    for (const candidate of body.keys) {
      const jwk = jwkSchema.safeParse(candidate)
      if (!jwk.success) continue
      try {
        keys.push({ kid: jwk.data.kid, key: createPublicKey({ key: jwk.data, format: 'jwk' }) })
      } catch {
        // A key this host cannot read is not one it can verify with.
      }
    }
    if (keys.length) cache.keys = keys
  } catch {
    // The cache stands; the interval still applies, so a dead endpoint is not called for each request.
  }
}

export function clearJwksCacheForTests(): void {
  jwksCaches.clear()
}

function decodePart<T>(part: string, schema: z.ZodType<T>): T | null {
  try {
    return schema.parse(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

async function verifyJwt(
  token: string,
  settings: Extract<WebhookVerification, { scheme: 'jwt' }>,
  context: VerificationContext,
): Promise<VerificationResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return fail('jwt_invalid', 'format')
  const header = decodePart(parts[0], jwtHeaderSchema)
  const claims = decodePart(parts[1], jwtClaimsSchema)
  if (!header) return fail('jwt_invalid', 'alg')
  if (!claims) return fail('jwt_invalid', 'format')
  const keys = await keysFor(settings.jwksUrl, header.kid, context.now, context.fetchImpl ?? fetch)
  if (!keys.length) return fail('keys_unavailable')
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8')
  const signature = Buffer.from(parts[2], 'base64url')
  const valid = keys.some((key) => {
    try {
      if (header.alg === 'EdDSA') return verifySignature(null, signed, key, signature)
      if (header.alg === 'ES256') return verifySignature('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature)
      return verifySignature('sha256', signed, key, signature)
    } catch {
      return false
    }
  })
  if (!valid) return fail('jwt_invalid', 'signature')
  if (claims.iss !== settings.issuer) return fail('jwt_invalid', 'iss')
  const audiences = claims.aud === undefined ? [] : Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(settings.audience)) return fail('jwt_invalid', 'aud')
  if (claims.exp === undefined || claims.exp * 1000 <= context.now - JWT_CLOCK_SKEW_MS) return fail('jwt_invalid', 'exp')
  if (claims.nbf !== undefined && claims.nbf * 1000 > context.now + JWT_CLOCK_SKEW_MS) return fail('jwt_invalid', 'nbf')
  return OK
}
