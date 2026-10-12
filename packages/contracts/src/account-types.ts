import type { AccountIdentity } from './auth/clients'

/**
 * The Solus account as the client shell sees it
 * (docs/adr/0001-standard-authentication.md §3.1). The client's `OAuthSession` owns
 * the sign-in (a refresh token); a renderer only receives this state. Hosts never see
 * any of it.
 */

export type AccountInvalidReason = 'revoked' | 'expired' | 'unreachable'

export type AccountState =
  | { kind: 'signed-out' }
  /** The browser step runs: the person signs in at `authorizeUrl` in the browser. */
  | { kind: 'signing-in'; authorizeUrl: string }
  | {
      kind: 'signed-in'
      /** The OIDC identity, from the ID token and then `/userinfo`. */
      identity: AccountIdentity
      /** The account website this sign-in belongs to, where the account and its teams are managed. */
      consoleUrl: string
      signedInAt: number
      /** True when the last call to the account website did not get an answer. */
      isStale: boolean
    }
  | { kind: 'invalid'; reason: AccountInvalidReason }
  /** The OS keychain is unavailable, so a sign-in cannot be stored safely. */
  | { kind: 'unavailable'; reason: 'encryption' }

/** How one sign-in attempt ended. */
export type SignInEnd = 'approved' | 'denied' | 'cancelled' | 'error'

/** How one device-grant sign-in (the CLI) ended: a code can also expire. */
export type DeviceSignInEnd = SignInEnd | 'expired'
