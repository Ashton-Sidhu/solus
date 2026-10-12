import { describe, expect, test } from 'bun:test'
import { identityClaimsSchema, tokenResourceUri } from '@solus/contracts/auth/clients'
import { ACCOUNT_AUDIENCE, SOLUS_API_AUDIENCE, hostAudience } from '@solus/contracts/uplink'

// docs/adr/0001-standard-authentication.md §3.1: a client names a resource at each
// refresh, and the account plane gives it a token with that audience. The value must
// be the audience the host or the Solus API checks, or every token is refused.

describe('tokenResourceUri', () => {
  test('names the audience that each resource server checks', () => {
    expect(tokenResourceUri({ kind: 'host', hostId: 'aaaaaaaaaaaaaaaa' })).toBe(hostAudience('aaaaaaaaaaaaaaaa'))
    expect(tokenResourceUri({ kind: 'api' })).toBe(SOLUS_API_AUDIENCE)
    expect(tokenResourceUri({ kind: 'account' })).toBe(ACCOUNT_AUDIENCE)
  })
})

describe('identityClaimsSchema', () => {
  test('reads the OIDC standard claims as an account identity', () => {
    expect(
      identityClaimsSchema.parse({ sub: 'user_1', email: 'a@example.test', email_verified: true, name: 'Ada', picture: 'https://example.test/a.png', iss: 'x' }),
    ).toEqual({ sub: 'user_1', email: 'a@example.test', emailVerified: true, name: 'Ada', picture: 'https://example.test/a.png' })
  })

  test('a person with no image or name has null, not an empty string', () => {
    // The account plane omits `picture` when the person has no image.
    expect(identityClaimsSchema.parse({ sub: 'user_1', email: 'a@example.test', email_verified: false, name: '' })).toMatchObject({ name: null, picture: null, emailVerified: false })
  })

  test('refuses claims with no email: a client cannot show who is signed in', () => {
    expect(identityClaimsSchema.safeParse({ sub: 'user_1', email_verified: true }).success).toBe(false)
  })
})
