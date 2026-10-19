import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync, sign, type KeyObject } from 'crypto'
import { AccessTokenVerifier, JWKS_REFRESH_MIN_INTERVAL_MS, type FetchLike } from '@solus/server/admission/access-tokens'
import { ACCESS_TOKEN_TTL_SECONDS, ACCOUNT_AUDIENCE, HOST_REACH_TOKEN_TTL_SECONDS, SOLUS_API_AUDIENCE, hostAudience, hostReachAudience } from '@solus/contracts/uplink'

// plans/010-standard-oauth.md: a host trusts one issuer and one key set, both from
// its link config, and accepts the account plane's access tokens for its own
// resource only. An access token is a bearer token for its short life; it keeps
// verifying through an account-plane outage with the keys the host already has.

const ISSUER = 'https://app.example.test'
const HOST_ID = 'abcdefghijklmnop'
const AUDIENCE = hostAudience(HOST_ID)

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }
  return { kid, privateKey, jwk }
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

/** Claims as a test states them: any shape, so a malformed token can be signed too. */
interface TestClaims { [claim: string]: string | number | object | undefined }

function signToken(privateKey: KeyObject, kid: string, claims: TestClaims, nowSeconds: number): string {
  const payload = {
    iss: ISSUER, aud: AUDIENCE, sub: 'user_1', grant_id: 'grant_1', jti: crypto.randomUUID(),
    iat: nowSeconds, exp: nowSeconds + 300, client_id: 'solus-desktop', ...claims,
  }
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid, typ: 'at+jwt' }))
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

describe('access token verification', () => {
  test('a token for this host from the linked issuer is accepted for its whole short life, not only once', async () => {
    // WHY: an OAuth access token is a bearer credential; a client keeps it and presents it again when it reconnects.
    const key = keyPair('k1')
    const verifier = new AccessTokenVerifier({ audience: AUDIENCE, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, fetchImpl: jwksFetch([key.jwk]).fetchImpl, now: () => NOW })
    const token = signToken(key.privateKey, key.kid, {}, nowSeconds)
    const first = await verifier.verify(token)
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.claims).toMatchObject({ sub: 'user_1', grant_id: 'grant_1', client_id: 'solus-desktop' })
    expect((await verifier.verify(token)).ok).toBe(true)
  })

  test('a person\'s token names its client grant; the old mint\'s token, which names a device instead, is refused', async () => {
    // WHY: ADR 0001 stage 1c — the mint is gone, so a token with no client grant and no acting host is no token of ours.
    const key = keyPair('k1')
    const verifier = new AccessTokenVerifier({ audience: AUDIENCE, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, fetchImpl: jwksFetch([key.jwk]).fetchImpl, now: () => NOW })
    const fromGrant = await verifier.verify(signToken(key.privateKey, key.kid, { organizations: [{ id: 'org1', role: 'member', teamIds: [] }] }, nowSeconds))
    expect(fromGrant).toMatchObject({ ok: true, claims: { grant_id: 'grant_1', organizations: [{ id: 'org1', role: 'member', teamIds: [] }] } })
    const oldMint = { grant_id: undefined, deviceId: 'session_1', client_id: 'solus-app', organizationId: 'org1', organizationRole: 'member' }
    expect(await verifier.verify(signToken(key.privateKey, key.kid, oldMint, nowSeconds))).toEqual({ ok: false, reason: 'malformed' })
  })

  test('a token for another host, another issuer, or a stranger\'s key is refused', async () => {
    // WHY: a token one host received must not open another host (RFC 8707 audience).
    const key = keyPair('k1')
    const stranger = keyPair('k1')
    const verifier = new AccessTokenVerifier({ audience: AUDIENCE, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, fetchImpl: jwksFetch([key.jwk]).fetchImpl, now: () => NOW })
    expect(await verifier.verify(signToken(key.privateKey, key.kid, { aud: hostAudience('qrstuvwxyzabcdef') }, nowSeconds))).toEqual({ ok: false, reason: 'wrong-audience' })
    expect(await verifier.verify(signToken(key.privateKey, key.kid, { aud: SOLUS_API_AUDIENCE }, nowSeconds))).toEqual({ ok: false, reason: 'wrong-audience' })
    expect(await verifier.verify(signToken(key.privateKey, key.kid, { iss: 'https://evil.example' }, nowSeconds))).toEqual({ ok: false, reason: 'wrong-issuer' })
    // Same kid, different key: the signature is the thing that fails.
    expect(await verifier.verify(signToken(stranger.privateKey, 'k1', {}, nowSeconds))).toEqual({ ok: false, reason: 'bad-signature' })
    expect(await verifier.verify('not.a.jwt')).toEqual({ ok: false, reason: 'malformed' })
  })

  test('expiry is how removal reaches a host, so it is enforced exactly and never stretched', async () => {
    const key = keyPair('k1')
    const verifier = new AccessTokenVerifier({ audience: AUDIENCE, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, fetchImpl: jwksFetch([key.jwk]).fetchImpl, now: () => NOW })
    expect(await verifier.verify(signToken(key.privateKey, key.kid, { iat: nowSeconds - 700, exp: nowSeconds - 1 }, nowSeconds))).toEqual({ ok: false, reason: 'expired' })
    // Eight hours, and one minute for a provider's rounding; nothing longer.
    expect(await verifier.verify(signToken(key.privateKey, key.kid, { exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS + 60 }, nowSeconds))).toMatchObject({ ok: true })
    expect(await verifier.verify(signToken(key.privateKey, key.kid, { exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS + 61 }, nowSeconds))).toEqual({ ok: false, reason: 'too-long-lived' })
    expect(await verifier.verify(signToken(key.privateKey, key.kid, { iat: nowSeconds + 300, exp: nowSeconds + 600 }, nowSeconds))).toEqual({ ok: false, reason: 'not-yet-valid' })
  })

  test('another host\'s host-reach token lives up to eight hours, and only when it names the acting host', async () => {
    // WHY: docs/plans/host-reach.md §3 — the account plane checks the reach when it
    // issues the token, so the token lives eight hours, and no client can hold a reach token.
    const key = keyPair('k1')
    const verifier = new AccessTokenVerifier({ audience: AUDIENCE, reachAudience: hostReachAudience(HOST_ID), issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, fetchImpl: jwksFetch([key.jwk]).fetchImpl, now: () => NOW })
    const reach = { aud: hostReachAudience(HOST_ID), act: { sub: 'host_other', host_id: 'other' }, access: 'owner', exp: nowSeconds + HOST_REACH_TOKEN_TTL_SECONDS }
    expect(await verifier.verify(signToken(key.privateKey, key.kid, reach, nowSeconds))).toMatchObject({ ok: true })
    expect(await verifier.verify(signToken(key.privateKey, key.kid, { ...reach, exp: nowSeconds + HOST_REACH_TOKEN_TTL_SECONDS + 61 }, nowSeconds))).toEqual({ ok: false, reason: 'too-long-lived' })
    expect(await verifier.verify(signToken(key.privateKey, key.kid, { ...reach, act: undefined, access: undefined }, nowSeconds))).toEqual({ ok: false, reason: 'wrong-audience' })
    expect(await verifier.verify(signToken(key.privateKey, key.kid, { ...reach, aud: hostReachAudience('another') }, nowSeconds))).toEqual({ ok: false, reason: 'wrong-audience' })
  })

  test('the Solus API accepts a host\'s delegated token, which names it among several audiences', async () => {
    // WHY: a delegated token is for the API and the account plane together (token exchange, RFC 8693).
    const key = keyPair('k1')
    const verifier = new AccessTokenVerifier({ audience: SOLUS_API_AUDIENCE, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, fetchImpl: jwksFetch([key.jwk]).fetchImpl, now: () => NOW })
    const delegated = signToken(key.privateKey, key.kid, { aud: [SOLUS_API_AUDIENCE, ACCOUNT_AUDIENCE], act: { sub: `host_${HOST_ID}`, host_id: HOST_ID }, access: 'org-member', organizationId: 'org_a', organizationRole: 'member', teamIds: [] }, nowSeconds)
    const verdict = await verifier.verify(delegated)
    expect(verdict.ok && verdict.claims.act).toEqual({ sub: `host_${HOST_ID}`, host_id: HOST_ID })
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
    const verifier = new AccessTokenVerifier({ audience: AUDIENCE, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, fetchImpl, now: () => now })
    expect((await verifier.verify(signToken(old.privateKey, 'k1', {}, nowSeconds))).ok).toBe(true)
    expect(calls.count).toBe(1)

    // Rotation on the control plane; the host has not refreshed yet and is rate-limited.
    served = [rotated.jwk]
    expect(await verifier.verify(signToken(rotated.privateKey, 'k2', {}, nowSeconds))).toEqual({ ok: false, reason: 'unknown-key' })
    expect(calls.count).toBe(1)

    now = NOW + JWKS_REFRESH_MIN_INTERVAL_MS
    expect((await verifier.verify(signToken(rotated.privateKey, 'k2', {}, Math.floor(now / 1000)))).ok).toBe(true)
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
    const verifier = new AccessTokenVerifier({ audience: AUDIENCE, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, fetchImpl, now: () => now })
    expect((await verifier.verify(signToken(key.privateKey, key.kid, {}, nowSeconds))).ok).toBe(true)
    down = true
    now = NOW + 2 * JWKS_REFRESH_MIN_INTERVAL_MS
    expect((await verifier.verify(signToken(key.privateKey, key.kid, {}, Math.floor(now / 1000)))).ok).toBe(true)
  })

  test('with no keys at all and no control plane, nothing is accepted', async () => {
    const key = keyPair('k1')
    const fetchImpl: FetchLike = async () => { throw new Error('offline') }
    const verifier = new AccessTokenVerifier({ audience: AUDIENCE, issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, fetchImpl, now: () => NOW })
    expect(await verifier.verify(signToken(key.privateKey, key.kid, {}, nowSeconds))).toEqual({ ok: false, reason: 'jwks-unavailable' })
  })
})
