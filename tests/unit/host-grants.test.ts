import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync, sign, type KeyObject } from 'crypto'
import { HostGrantVerifier, JWKS_REFRESH_MIN_INTERVAL_MS, type FetchLike } from '@solus/server/server/host-grants'
import type { HostGrantClaims } from '@solus/contracts/uplink'

// docs/plans/personal-uplink.md H1: the host trusts one issuer and one key set, both
// from its link config, accepts a grant once, and keeps verifying through a
// control-plane outage with the keys it already has.

const ISSUER = 'https://app.example.test'
const HOST_ID = 'abcdefghijklmnop'

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }
  return { kid, privateKey, jwk }
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function signGrant(privateKey: KeyObject, kid: string, claims: Partial<HostGrantClaims>, nowSeconds: number): string {
  const payload: HostGrantClaims = {
    iss: ISSUER, aud: HOST_ID, sub: 'user_1', deviceId: 'session_1', jti: crypto.randomUUID(),
    iat: nowSeconds, exp: nowSeconds + 600, ...claims,
  }
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }))
  const body = base64Url(JSON.stringify(payload))
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `${header}.${body}.${base64Url(signature)}`
}

function jwksFetch(keys: Array<ReturnType<typeof keyPair>['jwk']>, calls: { count: number } = { count: 0 }) {
  const fetchImpl: FetchLike = async () => {
    calls.count += 1
    return new Response(JSON.stringify({ keys }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

const NOW = 1_800_000_000_000
const nowSeconds = Math.floor(NOW / 1000)

describe('host grant verification', () => {
  test('a grant for this host from the linked issuer is accepted, once', async () => {
    const key = keyPair('k1')
    const verifier = new HostGrantVerifier({ link: { hostId: HOST_ID, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks` }, fetchImpl: jwksFetch([key.jwk]).fetchImpl, now: () => NOW })
    const grant = signGrant(key.privateKey, key.kid, {}, nowSeconds)
    const first = await verifier.verify(grant)
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.claims.sub).toBe('user_1')
      expect(first.claims.deviceId).toBe('session_1')
    }
    expect(await verifier.verify(grant)).toEqual({ ok: false, reason: 'replayed' })
  })

  test('a grant minted for another host, another issuer, or a stranger\'s key is refused', async () => {
    const key = keyPair('k1')
    const stranger = keyPair('k1')
    const verifier = new HostGrantVerifier({ link: { hostId: HOST_ID, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks` }, fetchImpl: jwksFetch([key.jwk]).fetchImpl, now: () => NOW })
    expect(await verifier.verify(signGrant(key.privateKey, key.kid, { aud: 'qrstuvwxyzabcdef' }, nowSeconds))).toEqual({ ok: false, reason: 'wrong-audience' })
    expect(await verifier.verify(signGrant(key.privateKey, key.kid, { iss: 'https://evil.example' }, nowSeconds))).toEqual({ ok: false, reason: 'wrong-issuer' })
    // Same kid, different key: the signature is the thing that fails.
    expect(await verifier.verify(signGrant(stranger.privateKey, 'k1', {}, nowSeconds))).toEqual({ ok: false, reason: 'bad-signature' })
    expect(await verifier.verify('not.a.jwt')).toEqual({ ok: false, reason: 'malformed' })
  })

  test('expiry is the revocation mechanism, so it is enforced exactly and never stretched', async () => {
    const key = keyPair('k1')
    const verifier = new HostGrantVerifier({ link: { hostId: HOST_ID, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks` }, fetchImpl: jwksFetch([key.jwk]).fetchImpl, now: () => NOW })
    expect(await verifier.verify(signGrant(key.privateKey, key.kid, { iat: nowSeconds - 700, exp: nowSeconds - 1 }, nowSeconds))).toEqual({ ok: false, reason: 'expired' })
    expect(await verifier.verify(signGrant(key.privateKey, key.kid, { exp: nowSeconds + 3_600 }, nowSeconds))).toEqual({ ok: false, reason: 'too-long-lived' })
    expect(await verifier.verify(signGrant(key.privateKey, key.kid, { iat: nowSeconds + 300, exp: nowSeconds + 900 }, nowSeconds))).toEqual({ ok: false, reason: 'not-yet-valid' })
  })

  test('an unknown kid refreshes the key set once, and a rotation is picked up', async () => {
    const old = keyPair('k1')
    const rotated = keyPair('k2')
    let served = [old.jwk]
    const calls = { count: 0 }
    const fetchImpl: FetchLike = async () => {
      calls.count += 1
      return new Response(JSON.stringify({ keys: served }), { status: 200 })
    }
    let now = NOW
    const verifier = new HostGrantVerifier({ link: { hostId: HOST_ID, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks` }, fetchImpl, now: () => now })
    expect((await verifier.verify(signGrant(old.privateKey, 'k1', {}, nowSeconds))).ok).toBe(true)
    expect(calls.count).toBe(1)

    // Rotation on the control plane; the host has not refreshed yet and is rate-limited.
    served = [rotated.jwk]
    expect(await verifier.verify(signGrant(rotated.privateKey, 'k2', {}, nowSeconds))).toEqual({ ok: false, reason: 'unknown-key' })
    expect(calls.count).toBe(1)

    now = NOW + JWKS_REFRESH_MIN_INTERVAL_MS
    expect((await verifier.verify(signGrant(rotated.privateKey, 'k2', {}, Math.floor(now / 1000)))).ok).toBe(true)
    expect(calls.count).toBe(2)
  })

  test('cached keys keep verifying while the control plane is down', async () => {
    const key = keyPair('k1')
    let down = false
    const fetchImpl: FetchLike = async () => {
      if (down) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 })
    }
    let now = NOW
    const verifier = new HostGrantVerifier({ link: { hostId: HOST_ID, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks` }, fetchImpl, now: () => now })
    expect((await verifier.verify(signGrant(key.privateKey, key.kid, {}, nowSeconds))).ok).toBe(true)
    down = true
    now = NOW + 2 * JWKS_REFRESH_MIN_INTERVAL_MS
    expect((await verifier.verify(signGrant(key.privateKey, key.kid, {}, Math.floor(now / 1000)))).ok).toBe(true)
  })

  test('with no keys at all and no control plane, nothing is accepted', async () => {
    const key = keyPair('k1')
    const fetchImpl: FetchLike = async () => { throw new Error('offline') }
    const verifier = new HostGrantVerifier({ link: { hostId: HOST_ID, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks` }, fetchImpl, now: () => NOW })
    expect(await verifier.verify(signGrant(key.privateKey, key.kid, {}, nowSeconds))).toEqual({ ok: false, reason: 'jwks-unavailable' })
  })
})
