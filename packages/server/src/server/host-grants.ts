import { createPublicKey, verify as verifySignature, type KeyObject } from 'crypto'
import { z } from 'zod'
import { HOST_GRANT_TTL_SECONDS, type HostGrantClaims, type UplinkLinkConfig } from '@solus/contracts/uplink'
import { createLogger } from '../logger'

const log = createLogger('main', 'host-grants')

/**
 * Verifies control-plane grants on the host (docs/plans/personal-uplink.md, H1).
 * The host trusts exactly one issuer and one key set, both named in its link config,
 * and accepts a grant once: `jti` is consumed for the grant's lifetime, so a captured
 * grant cannot open a second socket.
 *
 * JWKS is cached and survives a control-plane outage: keys already seen keep
 * verifying until the grant TTL would have expired them anyway. An unknown `kid`
 * triggers one refresh, rate-limited, so a key rotation is picked up without letting
 * a stranger make the host hammer the JWKS endpoint.
 */

export type GrantRejection =
  | 'malformed'
  | 'unknown-key'
  | 'bad-signature'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'expired'
  | 'not-yet-valid'
  | 'too-long-lived'
  | 'replayed'
  | 'jwks-unavailable'
  /** This host holds no link, so no grant can be for it. */
  | 'not-linked'

export type GrantVerdict =
  | { ok: true; claims: HostGrantClaims }
  | { ok: false; reason: GrantRejection }

/** The slice of `fetch` this module uses; a test fake need not carry the rest. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface HostGrantVerifierOptions {
  link: Pick<UplinkLinkConfig, 'hostId' | 'issuer' | 'jwksUrl'>
  fetchImpl?: FetchLike
  now?: () => number
  /** Grants issued before this instant are refused; defaults to construction time. */
  startedAt?: number
}

/** Do not refetch JWKS for unknown kids more often than this. */
export const JWKS_REFRESH_MIN_INTERVAL_MS = 60_000
/** Allowed clock skew for `iat`. */
const IAT_SKEW_MS = 60_000

const headerSchema = z.object({ alg: z.literal('ES256'), kid: z.string().min(1) })
const claimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.union([z.string().min(1), z.array(z.string())]),
  sub: z.string().min(1),
  deviceId: z.string().min(1),
  jti: z.string().min(1),
  iat: z.number(),
  exp: z.number(),
})
const jwkSchema = z.object({
  kid: z.string().min(1),
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().min(1),
  y: z.string().min(1),
})
const jwksSchema = z.object({ keys: z.array(z.unknown()) })

/** One base64url JWT segment, parsed against its schema; throws on anything else. */
function decodeJwtPart<T>(part: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')))
}

export class HostGrantVerifier {
  private readonly keys = new Map<string, KeyObject>()
  private lastRefreshAt = 0
  private refreshInFlight: Promise<void> | null = null
  /** jti → grant expiry (ms). Pruned on every verification. */
  private readonly usedGrantIds = new Map<string, number>()
  /** Consumed ids live in memory only, so nothing issued before this verifier existed is accepted. */
  private readonly startedAt: number

  constructor(private readonly options: HostGrantVerifierOptions) {
    this.startedAt = options.startedAt ?? options.now?.() ?? Date.now()
  }

  get hostId(): string {
    return this.options.link.hostId
  }

  /** Verifies and consumes one grant. */
  async verify(token: string): Promise<GrantVerdict> {
    const now = this.options.now?.() ?? Date.now()
    this.pruneUsedGrantIds(now)

    const parts = token.split('.')
    if (parts.length !== 3) return { ok: false, reason: 'malformed' }
    const [headerPart, payloadPart, signaturePart] = parts
    let header: z.infer<typeof headerSchema>
    let claims: z.infer<typeof claimsSchema>
    try {
      header = decodeJwtPart(headerPart, headerSchema)
      claims = decodeJwtPart(payloadPart, claimsSchema)
    } catch {
      return { ok: false, reason: 'malformed' }
    }

    const key = await this.keyFor(header.kid, now)
    // No key set at all means the control plane was never reached; a key set that
    // lacks this kid means the grant was signed with something we do not trust.
    if (!key) return { ok: false, reason: this.keys.size === 0 ? 'jwks-unavailable' : 'unknown-key' }

    const signed = Buffer.from(`${headerPart}.${payloadPart}`)
    const signature = Buffer.from(signaturePart, 'base64url')
    let valid = false
    try {
      valid = verifySignature('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature)
    } catch {
      valid = false
    }
    if (!valid) return { ok: false, reason: 'bad-signature' }

    if (claims.iss !== this.options.link.issuer) return { ok: false, reason: 'wrong-issuer' }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!audiences.includes(this.options.link.hostId)) return { ok: false, reason: 'wrong-audience' }
    if (claims.exp * 1000 <= now) return { ok: false, reason: 'expired' }
    if (claims.iat * 1000 > now + IAT_SKEW_MS) return { ok: false, reason: 'not-yet-valid' }
    if (claims.iat * 1000 < this.startedAt - IAT_SKEW_MS) return { ok: false, reason: 'replayed' }
    if (claims.exp - claims.iat > HOST_GRANT_TTL_SECONDS) return { ok: false, reason: 'too-long-lived' }
    if (this.usedGrantIds.has(claims.jti)) return { ok: false, reason: 'replayed' }

    this.usedGrantIds.set(claims.jti, claims.exp * 1000)
    const audience = audiences.find((entry) => entry === this.options.link.hostId) ?? this.options.link.hostId
    return { ok: true, claims: { ...claims, aud: audience } }
  }

  private async keyFor(kid: string, now: number): Promise<KeyObject | null> {
    const cached = this.keys.get(kid)
    if (cached) return cached
    if (now - this.lastRefreshAt >= JWKS_REFRESH_MIN_INTERVAL_MS || this.lastRefreshAt === 0) {
      await this.refreshKeys(now)
    }
    return this.keys.get(kid) ?? null
  }

  private refreshKeys(now: number): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      const fetchImpl: FetchLike = this.options.fetchImpl ?? fetch
      try {
        const response = await fetchImpl(this.options.link.jwksUrl, { signal: AbortSignal.timeout(5_000) })
        if (!response.ok) throw new Error(`JWKS answered ${response.status}`)
        const body = jwksSchema.parse(await response.json())
        const next = new Map<string, KeyObject>()
        for (const candidate of body.keys) {
          const jwk = jwkSchema.safeParse(candidate)
          if (!jwk.success) continue
          next.set(jwk.data.kid, createPublicKey({ key: jwk.data, format: 'jwk' }))
        }
        // A key set that came back empty is a control-plane fault, not a rotation:
        // keep what we have rather than locking every client out.
        if (next.size > 0) {
          this.keys.clear()
          for (const [kid, key] of next) this.keys.set(kid, key)
        }
        this.lastRefreshAt = now
        log.info('host_grant_jwks_refreshed', { keys: this.keys.size })
      } catch (err) {
        // The cache stands; the interval still applies so a dead endpoint is not polled per request.
        this.lastRefreshAt = now
        log.warn('host_grant_jwks_refresh_failed', { error: err instanceof Error ? err.message : String(err) })
      } finally {
        this.refreshInFlight = null
      }
    })()
    return this.refreshInFlight
  }

  private pruneUsedGrantIds(now: number): void {
    for (const [jti, expiresAt] of this.usedGrantIds) {
      if (expiresAt <= now) this.usedGrantIds.delete(jti)
    }
  }
}
