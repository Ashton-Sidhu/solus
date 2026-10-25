import { join } from 'path'
import { z } from 'zod'
import {
  CLIENT_ASSERTION_TYPE,
  CONTROL_AUDIENCE,
  HOST_CONTROL_SCOPE,
  hostPublicJwkSchema,
  type HostPublicJwk,
} from '@solus/contracts/uplink'
import type { FetchLike } from '../admission/access-tokens'
import { dataDir } from '../platform/paths'
import { secretStore } from '../platform/secrets'

/**
 * The one credential a host holds to prove that it is that host
 * (docs/adr/0001-standard-authentication.md §2.2 rule 8, §3.4): an ES256 key pair it
 * made itself. The account plane keeps only the public half, as the `jwks` of the
 * host's OAuth client. The host signs a client assertion (RFC 7523, `private_key_jwt`)
 * at the token endpoint: to get its own control token (client credentials, for its
 * link routes and a person's delegated tokens) and to make a delegation (token exchange, `Delegations`).
 * The Solus API holds the same kind of key, its service credential (§6.2).
 */
export interface HostCredential {
  readonly clientId: string
  /** The account plane's token endpoint, where every assertion of this credential goes. */
  readonly tokenEndpoint: string
  /** A signed client assertion (RFC 7523) for `audience`: 150 s of life, used once. */
  assertion(audience: string): Promise<string>
  /** The host's own access token (client credentials) for its link routes; kept until 60 s before its end. */
  hostAccessToken(): Promise<string>
}

/** The private half, as it is kept: an ES256 JWK on P-256. */
export const privateJwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().min(1),
  y: z.string().min(1),
  d: z.string().min(1),
})
export type PrivateJwk = z.infer<typeof privateJwkSchema>

/** Why the host has no control token: the account plane refused its key, or could not be asked. */
export class HostCredentialError extends Error {
  constructor(readonly code: 'refused' | 'unreachable', message: string) {
    super(message)
    this.name = 'HostCredentialError'
  }
}

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const
/**
 * The account plane takes an assertion while its `exp` is ahead of the account
 * plane's clock and at most 300 s ahead (better-auth's `assertionMaxLifetime`). Half
 * of that lets this host's clock be up to 150 s behind or ahead. The account plane
 * keeps each `jti` until `exp`, so an assertion is still used once.
 */
const ASSERTION_LIFE_SECONDS = 150
/** A control token this close to its end is replaced before it is used. */
const RENEWAL_MARGIN_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000

/** A new key pair. The private half never leaves this machine; only the public half is sent. */
export async function generateHostKey(): Promise<{ privateJwk: PrivateJwk; publicJwk: HostPublicJwk }> {
  const pair = await crypto.subtle.generateKey(ECDSA_P256, true, ['sign', 'verify'])
  const privateJwk = privateJwkSchema.parse(await crypto.subtle.exportKey('jwk', pair.privateKey))
  return { privateJwk, publicJwk: publicJwkOf(privateJwk) }
}

export function publicJwkOf(privateJwk: PrivateJwk): HostPublicJwk {
  const { kty, crv, x, y } = privateJwk
  return hostPublicJwkSchema.parse({ kty, crv, x, y })
}

const tokenAnswerSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() })
const oauthErrorSchema = z.object({ error: z.string(), error_description: z.string().optional() })

/** better-auth's refusals of an assertion's `exp` and `iat` (`consumeClientAssertion`). */
function isClockRefusal(description: string | undefined): boolean {
  return !!description && /^client assertion (has expired|exp is too far in the future|iat is too far in the past)/.test(description)
}

function base64url(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString('base64url')
}

/** A credential with its key: signs assertions, and gets and keeps the host's control token. */
export function clientCredential(input: {
  clientId: string
  privateJwk: PrivateJwk
  tokenEndpoint: string
  fetchImpl?: FetchLike
  now?: () => number
}): HostCredential {
  const now = input.now ?? Date.now
  const signingKey = crypto.subtle.importKey('jwk', input.privateJwk, ECDSA_P256, false, ['sign'])
  let held: { token: string; expiresAt: number } | null = null
  let fetching: Promise<string> | null = null

  const assertion = async (audience: string): Promise<string> => {
    const issuedAt = Math.floor(now() / 1000)
    const header = base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))
    const payload = base64url(JSON.stringify({
      iss: input.clientId,
      sub: input.clientId,
      aud: audience,
      jti: crypto.randomUUID(),
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFE_SECONDS,
    }))
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey, new TextEncoder().encode(`${header}.${payload}`))
    return `${header}.${payload}.${base64url(new Uint8Array(signature))}`
  }

  const fetchControlToken = async (): Promise<string> => {
    const fetchImpl: FetchLike = input.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(input.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          resource: CONTROL_AUDIENCE,
          scope: HOST_CONTROL_SCOPE,
          client_id: input.clientId,
          client_assertion_type: CLIENT_ASSERTION_TYPE,
          client_assertion: await assertion(input.tokenEndpoint),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new HostCredentialError('unreachable', `Solus is not reachable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const body: unknown = await response.json().catch(() => null)
    const answer = tokenAnswerSchema.safeParse(body)
    if (response.ok && answer.success) {
      held = { token: answer.data.access_token, expiresAt: now() + answer.data.expires_in * 1000 }
      return answer.data.access_token
    }
    // `invalid_client`: the account plane no longer knows this key — another copy linked, or the link is gone.
    const refusal = oauthErrorSchema.safeParse(body)
    // The account plane also says `invalid_client` when the assertion's times do not fit its clock.
    // The key is good: the clock is wrong, and is often set right soon after boot.
    if (refusal.success && isClockRefusal(refusal.data.error_description)) {
      throw new HostCredentialError('unreachable', `Solus cloud refused the time on this host’s clock: ${refusal.data.error_description}. Check the clock.`)
    }
    if (refusal.success && (refusal.data.error === 'invalid_client' || refusal.data.error === 'unauthorized_client')) {
      throw new HostCredentialError('refused', refusal.data.error_description ?? 'Solus does not accept this host’s key.')
    }
    throw new HostCredentialError('unreachable', `Solus could not issue this host’s token (${response.status}).`)
  }

  return {
    clientId: input.clientId,
    tokenEndpoint: input.tokenEndpoint,
    assertion,
    hostAccessToken: () => {
      if (held && held.expiresAt - now() > RENEWAL_MARGIN_MS) return Promise.resolve(held.token)
      fetching ??= fetchControlToken().finally(() => { fetching = null })
      return fetching
    },
  }
}

// ── The host's own key, in the secret store ─────────────────────────────────

const SECRET_KEY = 'host-credential'

/**
 * The host's key for its current link. `generation` is the link generation it was made
 * for, so a provisioned host that boots again before its registration was answered
 * sends the same key, and a newer link gets a new one.
 */
const storedKeySchema = z.object({
  version: z.literal(1),
  clientId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  privateJwk: privateJwkSchema,
})
export type StoredHostKey = z.infer<typeof storedKeySchema>

export function loadHostKey(): StoredHostKey | null {
  return secretStore().loadJson(SECRET_KEY, electronPath(), storedKeySchema)
}

export function saveHostKey(key: Omit<StoredHostKey, 'version'>): void {
  secretStore().saveJson(SECRET_KEY, electronPath(), { version: 1, ...key })
}

export function forgetHostKey(): void {
  secretStore().remove(SECRET_KEY, electronPath())
}

function electronPath(): string {
  return join(dataDir(), 'host-credential.bin')
}
