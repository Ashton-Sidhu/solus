import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'crypto'
import { AccessTokenVerifier, type FetchLike } from '@solus/server/admission/access-tokens'
import { clientCredential, generateHostKey } from '@solus/server/host/host-credential'
import { hostAudience } from '@solus/contracts/uplink'

// A host's clock is often not the account plane's: a machine that just booted, a VM
// restored from a snapshot, or a laptop without network time. A few minutes of
// difference must not lock the host out of its own control token, and must not make it
// refuse the tokens of its own people (T3 Code #19640 made the same change).

const ISSUER = 'https://app.example.test'
const AUDIENCE = hostAudience('abcdefghijklmnop')
const TOKEN_ENDPOINT = `${ISSUER}/api/auth/oauth2/token`
const CLOUD_NOW = 1_800_000_000

describe('the host verifies a token from a clock that is not its own', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' }
  const fetchImpl: FetchLike = async () => Response.json({ keys: [jwk] })

  /** A token the account plane issued at its own `CLOUD_NOW`, eight hours long, checked when the host's clock reads `hostNow`. */
  function verifyAt(hostNowSeconds: number, issuedAt = CLOUD_NOW, expiresAt = CLOUD_NOW + 8 * 3600) {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })).toString('base64url')
    const body = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: 'user_1', grant_id: 'grant_1', client_id: 'solus-desktop', jti: 'j1', iat: issuedAt, exp: expiresAt })).toString('base64url')
    const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    const verifier = new AccessTokenVerifier({ audience: AUDIENCE, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, fetchImpl, now: () => hostNowSeconds * 1000 })
    return verifier.verify(`${header}.${body}.${signature}`)
  }

  test('a host clock up to two minutes behind takes a token just issued', async () => {
    expect(await verifyAt(CLOUD_NOW - 119)).toMatchObject({ ok: true })
    expect(await verifyAt(CLOUD_NOW - 121)).toEqual({ ok: false, reason: 'not-yet-valid' })
  })

  test('expiry gets no leeway: removal reaches a host when the token ends', async () => {
    const expiresAt = CLOUD_NOW + 8 * 3600
    expect(await verifyAt(expiresAt - 1)).toMatchObject({ ok: true })
    expect(await verifyAt(expiresAt)).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('the host’s client assertion fits the account plane’s clock', () => {
  /**
   * What the account plane (better-auth `consumeClientAssertion`, `assertionMaxLifetime`
   * 300 s) checks, at its own clock: `exp` is ahead, but at most 300 s ahead, and `iat`
   * at most 300 s past.
   */
  function accountPlaneTakes(assertion: string, cloudNowSeconds: number): boolean {
    const claims: { iat: number; exp: number } = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString('utf8'))
    return claims.exp > cloudNowSeconds && claims.exp - cloudNowSeconds <= 300 && cloudNowSeconds - claims.iat <= 300
  }

  async function assertionFromClock(offsetSeconds: number): Promise<string> {
    const key = await generateHostKey()
    const credential = clientCredential({ clientId: 'host_h1', privateJwk: key.privateJwk, tokenEndpoint: TOKEN_ENDPOINT, now: () => (CLOUD_NOW + offsetSeconds) * 1000 })
    return credential.assertion(TOKEN_ENDPOINT)
  }

  test('a host clock two minutes behind or ahead still gets an assertion accepted', async () => {
    // With one minute of life, a host two minutes behind signed an assertion that had expired on arrival.
    for (const offset of [-140, -120, -61, 0, 61, 120, 140]) {
      expect({ offset, isAccepted: accountPlaneTakes(await assertionFromClock(offset), CLOUD_NOW) }).toEqual({ offset, isAccepted: true })
    }
  })

  test('the assertion stays inside the account plane’s 300 s limit for a clock on time', async () => {
    const claims = JSON.parse(Buffer.from((await assertionFromClock(0)).split('.')[1]!, 'base64url').toString('utf8'))
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300)
  })
})

describe('a clock refusal is not a refused key', () => {
  test('the account plane’s `invalid_client` for an assertion out of its time is a passing fault, so the registration is kept', async () => {
    // Before, every `invalid_client` meant "this key is no longer known", and the
    // registrar forgot its registration and key: a wrong clock ended the registration.
    const key = await generateHostKey()
    let description = 'client assertion has expired'
    const credential = clientCredential({
      clientId: 'host_h1', privateJwk: key.privateJwk, tokenEndpoint: TOKEN_ENDPOINT,
      fetchImpl: async () => Response.json({ error: 'invalid_client', error_description: description }, { status: 400 }),
    })
    for (const refusal of ['client assertion has expired', 'client assertion exp is too far in the future (max 300s)', 'client assertion iat is too far in the past (max 300s)']) {
      description = refusal
      await expect(credential.hostAccessToken()).rejects.toMatchObject({ code: 'unreachable' })
    }
    description = 'client assertion signature verification failed'
    await expect(credential.hostAccessToken()).rejects.toMatchObject({ code: 'refused' })
  })
})
