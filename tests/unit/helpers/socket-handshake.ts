import { SOLUS_PROTOCOL, type AccessTokenClaims, type HandshakeCredential } from '@solus/contracts/uplink'
import type { TokenVerdict } from '@solus/server/admission/access-tokens'

/** A socket handshake as a current client sends it: the protocol, and at most one credential. */
export function handshake(credential?: HandshakeCredential, clientInstanceId?: string): { protocol: number; credential?: HandshakeCredential; clientInstanceId?: string } {
  const auth: { protocol: number; credential?: HandshakeCredential; clientInstanceId?: string } = { protocol: SOLUS_PROTOCOL }
  if (credential) auth.credential = credential
  if (clientInstanceId) auth.clientInstanceId = clientInstanceId
  return auth
}

/** The claims a test's token stands for: a person's client token unless it names `act`. */
export type TestClaims = Partial<AccessTokenClaims> & { sub?: string; grant_id?: string; exp?: number }

/**
 * Access tokens without signatures: the verifier is the seam (the real one is tested in
 * access-tokens.test.ts). A token is JWT-shaped, so the HTTP door reads it as one.
 */
export function fakeAccessTokens() {
  const tokens = new Map<string, AccessTokenClaims>()
  let next = 0
  return {
    /** A token for these claims; it ends at `expiresAt` (ms), a minute from now by default. */
    mint(claims: TestClaims = {}, expiresAt = Date.now() + 60_000): string {
      const token = `test.${++next}.token`
      const nowSeconds = Math.floor(Date.now() / 1000)
      // SAFETY: a test states only the claims it needs; the verifier's schema is tested elsewhere.
      tokens.set(token, { iss: 'https://account.test', aud: 'urn:solus:host:test', sub: 'user_1', grant_id: 'grant_1', jti: token, iat: nowSeconds, exp: expiresAt / 1000, access: 'owner', ...claims } as AccessTokenClaims)
      return token
    },
    verify: async (token: string): Promise<TokenVerdict> => {
      const claims = tokens.get(token)
      return claims ? { ok: true, claims } : { ok: false, reason: 'bad-signature' }
    },
  }
}
