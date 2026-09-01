/**
 * The Solus account as the client shell sees it. The desktop main process owns the
 * account session (an encrypted Better Auth session token); the renderer only ever
 * receives this state. Hosts never see any of it.
 */

export interface AccountProfile {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
}

export type AccountInvalidReason = 'revoked' | 'expired' | 'unreachable'

export type AccountState =
  | { kind: 'signed-out' }
  | {
      kind: 'signing-in'
      /** The code the person confirms in the browser, formatted `BCDF-GHJK`. */
      userCode: string
      /** The approval page with the code prefilled; opened automatically once. */
      verificationUrl: string
      expiresAt: number
    }
  | {
      kind: 'signed-in'
      profile: AccountProfile
      signedInAt: number
      /** When the website last confirmed the session; older than `signedInAt` never. */
      lastVerifiedAt: number
      /** True when the last verification could not reach the website. */
      isStale: boolean
    }
  | { kind: 'invalid'; reason: AccountInvalidReason }
  /** The OS keychain is unavailable, so a session cannot be stored safely. */
  | { kind: 'unavailable'; reason: 'encryption' }

/** How one device sign-in attempt ended. */
export type DeviceSignInEnd = 'approved' | 'denied' | 'expired' | 'cancelled' | 'error'
