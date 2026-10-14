import { z } from 'zod'
import { ACCESS_TOKEN_TTL_SECONDS, ACCOUNT_AUDIENCE, SOLUS_API_AUDIENCE, hostAudience, hostReachAudience } from '../uplink'

/**
 * The Solus clients of the account plane (docs/adr/0001-standard-authentication.md
 * §3.1). Each one is a public OAuth client: desktop and mobile sign in with the
 * authorization code and PKCE through the system browser, the web client on the
 * account origin, and the CLI with the device grant. Each sign-in is one client grant.
 */
export const SOLUS_CLIENT_IDS = {
  desktop: 'solus-desktop',
  mobile: 'solus-mobile',
  web: 'solus-web',
  cli: 'solus-cli',
} as const

export type SolusClientId = (typeof SOLUS_CLIENT_IDS)[keyof typeof SOLUS_CLIENT_IDS]

/** The scopes of one sign-in. A client asks for no `resource` at sign-in, and names one at each refresh. */
export const SIGN_IN_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const

/** An access token lives one hour. The same value as the Uplink contract. */
export { ACCESS_TOKEN_TTL_SECONDS }

/** What one access token is for (RFC 8707 `resource`). */
export type TokenResource =
  | { kind: 'host'; hostId: string }
  /** Another host, as a host reaches it for a person (docs/plans/host-reach.md §3). Only a host's delegation asks for it. */
  | { kind: 'host-reach'; hostId: string }
  | { kind: 'api' }
  | { kind: 'account' }

/** A resource that a client renderer may get a token for: a host or the Solus API, never the account plane. */
export type ConnectionTokenResource = Exclude<TokenResource, { kind: 'account' } | { kind: 'host-reach' }>

/** The `resource` value that asks for a token for `resource`. */
export function tokenResourceUri(resource: TokenResource): string {
  switch (resource.kind) {
    case 'host':
      return hostAudience(resource.hostId)
    case 'host-reach':
      return hostReachAudience(resource.hostId)
    case 'api':
      return SOLUS_API_AUDIENCE
    case 'account':
      return ACCOUNT_AUDIENCE
  }
}

/** OIDC standard claims: the only identity a client reads. */
export interface AccountIdentity {
  sub: string
  email: string
  emailVerified: boolean
  name: string | null
  picture: string | null
}

/**
 * The identity claims of an ID token or a `/userinfo` answer (OIDC Core §5.1), read
 * as an `AccountIdentity`. The account plane gives `name` and `picture` with the
 * `profile` scope, and omits `picture` when the person has no image.
 */
export const identityClaimsSchema = z
  .object({
    sub: z.string().min(1),
    email: z.string().min(1),
    email_verified: z.boolean(),
    name: z.string().nullish(),
    picture: z.string().nullish(),
  })
  .transform(
    (claims): AccountIdentity => ({
      sub: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified,
      name: claims.name || null,
      picture: claims.picture || null,
    }),
  )
