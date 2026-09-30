import { createPublicKey, verify as verifySignature, type KeyObject } from 'crypto'
import { z } from 'zod'
import { GUEST_GRANT_TTL_SECONDS, accessTokenClaimsSchema, tokenAudiences, type AccessTokenClaims } from '@solus/contracts/uplink'
import { createLogger } from '../logger'

const log = createLogger('main', 'access-tokens')

/**
 * Verifies the account plane's tokens offline (plans/010-standard-oauth.md): its OAuth
 * access tokens (RFC 9068) and its guest grants. A host trusts exactly one issuer and
 * one key set, both named in its link config, and accepts a token for one resource:
 * its own (`hostAudience(hostId)`), or `SOLUS_API_AUDIENCE` on the Solus API.
 *
 * A token is a bearer credential for its short life, as OAuth access tokens are: it
 * is not spent, and an access token lives five minutes. Removal reaches a host when the
 * token runs out and the next one is refused.
 *
 * JWKS is cached and survives an account-plane outage: keys already seen keep
 * verifying. An unknown `kid` triggers one refresh, rate-limited, so a key rotation is
 * picked up without letting a stranger make the host hammer the JWKS endpoint.
 */

export type TokenRejection =
  | 'malformed'
  | 'unknown-key'
  | 'bad-signature'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'expired'
  | 'not-yet-valid'
  | 'too-long-lived'
  | 'jwks-unavailable'
  /** This host holds no link, so no token can be for it. */
  | 'not-linked'

export type TokenVerdict =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: TokenRejection }

/** The slice of `fetch` this module uses; a test fake need not carry the rest. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface AccessTokenVerifierOptions {
  issuer: string
  jwksUrl: string
  /** The resource every accepted token must name: this host's, or the Solus API's. */
  audience: string
  fetchImpl?: FetchLike
  now?: () => number
}

/** Do not refetch JWKS for unknown kids more often than this. */
export const JWKS_REFRESH_MIN_INTERVAL_MS = 60_000
/** Allowed clock skew for `iat`. */
const IAT_SKEW_MS = 60_000

const headerSchema = z.object({ alg: z.literal('ES256'), kid: z.string().min(1) })
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

export class AccessTokenVerifier {
  private readonly keys = new Map<string, KeyObject>()
  private lastRefreshAt = 0
  private refreshInFlight: Promise<void> | null = null

  constructor(private readonly options: AccessTokenVerifierOptions) {}

  get audience(): string {
    return this.options.audience
  }

  async verify(token: string): Promise<TokenVerdict> {
    const now = this.options.now?.() ?? Date.now()
    const parts = token.split('.')
    if (parts.length !== 3) return { ok: false, reason: 'malformed' }
    const [headerPart, payloadPart, signaturePart] = parts
    let header: z.infer<typeof headerSchema>
    let claims: AccessTokenClaims
    try {
      header = decodeJwtPart(headerPart, headerSchema)
      // Parsing with the contract schema keeps the membership facts (access,
      // organization, teams) on the verdict; a narrower schema would strip them.
      claims = decodeJwtPart(payloadPart, accessTokenClaimsSchema)
    } catch {
      return { ok: false, reason: 'malformed' }
    }

    const key = await this.keyFor(header.kid, now)
    // No key set at all means the account plane was never reached; a key set that
    // lacks this kid means the token was signed with something we do not trust.
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

    if (claims.iss !== this.options.issuer) return { ok: false, reason: 'wrong-issuer' }
    if (!tokenAudiences(claims).includes(this.options.audience)) return { ok: false, reason: 'wrong-audience' }
    if (claims.exp * 1000 <= now) return { ok: false, reason: 'expired' }
    if (claims.iat * 1000 > now + IAT_SKEW_MS) return { ok: false, reason: 'not-yet-valid' }
    if (claims.exp - claims.iat > GUEST_GRANT_TTL_SECONDS) return { ok: false, reason: 'too-long-lived' }
    return { ok: true, claims }
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
        const response = await fetchImpl(this.options.jwksUrl, { signal: AbortSignal.timeout(5_000) })
        if (!response.ok) throw new Error(`JWKS answered ${response.status}`)
        const body = jwksSchema.parse(await response.json())
        const next = new Map<string, KeyObject>()
        for (const candidate of body.keys) {
          const jwk = jwkSchema.safeParse(candidate)
          if (!jwk.success) continue
          next.set(jwk.data.kid, createPublicKey({ key: jwk.data, format: 'jwk' }))
        }
        // A key set that came back empty is an account-plane fault, not a rotation:
        // keep what we have rather than locking every client out.
        if (next.size > 0) {
          this.keys.clear()
          for (const [kid, key] of next) this.keys.set(kid, key)
        }
        this.lastRefreshAt = now
        log.info('access_token_jwks_refreshed', { keys: this.keys.size })
      } catch (err) {
        // The cache stands; the interval still applies so a dead endpoint is not polled per request.
        this.lastRefreshAt = now
        log.warn('access_token_jwks_refresh_failed', { error: err instanceof Error ? err.message : String(err) })
      } finally {
        this.refreshInFlight = null
      }
    })()
    return this.refreshInFlight
  }
}
