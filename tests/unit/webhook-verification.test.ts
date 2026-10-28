import { beforeEach, describe, expect, test } from 'bun:test'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import type { WebhookVerification } from '@solus/contracts/webhooks'
import { requestData } from '@solus/server/execution/webhooks/request-data'
import { clearJwksCacheForTests, decodeStandardWebhooksSecret, verifyRequest } from '@solus/server/execution/webhooks/verification'
import { deliveryProof, readDeliveryProof } from '@solus/server/execution/webhooks/delivery-proof'

// docs/plans/webhooks.md §3.7: the URL token alone is not enough. Each generic
// scheme must accept the sender's real signature and refuse anything else, and a
// failure must name the step, so the owner can fix the settings without seeing
// a secret.

const NOW = Date.parse('2026-10-28T12:00:00Z')
const body = Buffer.from('{"action":"opened"}')
const secret = Buffer.from('shh')

function request(headers: [string, string][]) {
  return requestData('POST', headers, [], body)
}

describe('hmac', () => {
  const github: WebhookVerification = {
    scheme: 'hmac', algorithm: 'sha256', signedText: '{{body}}',
    signature: { source: { kind: 'header', name: 'x-hub-signature-256' }, format: { encoding: 'hex', prefix: 'sha256=' } },
  }
  const good = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

  test('a prefixed hex signature over the raw body passes', async () => {
    expect(await verifyRequest(github, request([['X-Hub-Signature-256', good]]), { secret, now: NOW })).toEqual({ ok: true })
  })

  test('a missing header, a wrong signature, and no stored secret each name their step', async () => {
    expect(await verifyRequest(github, request([]), { secret, now: NOW })).toEqual({ ok: false, failure: { step: 'value_missing', detail: 'x-hub-signature-256' } })
    expect(await verifyRequest(github, request([['x-hub-signature-256', 'sha256=00']]), { secret, now: NOW })).toEqual({ ok: false, failure: { step: 'signature_mismatch' } })
    expect(await verifyRequest(github, request([['x-hub-signature-256', good]]), { secret: null, now: NOW })).toEqual({ ok: false, failure: { step: 'secret_missing' } })
  })

  test('a header part and a timestamp: one of several signatures matches, an old request fails', async () => {
    const stripeLike: WebhookVerification = {
      scheme: 'hmac', algorithm: 'sha256', signedText: '{{headers.x-sig|t}}.{{body}}',
      signature: { source: { kind: 'header_part', name: 'x-sig', key: 'v1', separator: ',' }, format: { encoding: 'hex' } },
      timestamp: { source: { kind: 'header_part', name: 'x-sig', key: 't', separator: ',' }, toleranceSeconds: 300 },
    }
    const t = String(Math.floor(NOW / 1000))
    const signature = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
    const header = `t=${t},v1=${'0'.repeat(64)},v1=${signature}`
    expect(await verifyRequest(stripeLike, request([['x-sig', header]]), { secret, now: NOW })).toEqual({ ok: true })
    expect(await verifyRequest(stripeLike, request([['x-sig', header]]), { secret, now: NOW + 301_000 })).toEqual({ ok: false, failure: { step: 'timestamp_outside_tolerance' } })
  })

  test('base64 signatures in a list form', async () => {
    const listed: WebhookVerification = {
      scheme: 'hmac', algorithm: 'sha512', signedText: '{{body}}',
      signature: { source: { kind: 'header', name: 'x-sigs' }, format: { encoding: 'base64', listSeparator: ' ' } },
    }
    const signature = createHmac('sha512', secret).update(body).digest('base64')
    expect(await verifyRequest(listed, request([['x-sigs', `bad= ${signature}`]]), { secret, now: NOW })).toEqual({ ok: true })
  })
})

describe('public_key', () => {
  test('ed25519 with a raw hex key and a timestamp in the signed text', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')
    const verification: WebhookVerification = {
      scheme: 'public_key', algorithm: 'ed25519', publicKey: raw, signedText: '{{headers.x-signature-timestamp}}{{body}}',
      signature: { source: { kind: 'header', name: 'x-signature-ed25519' }, format: { encoding: 'hex' } },
    }
    const t = String(Math.floor(NOW / 1000))
    const signature = sign(null, Buffer.concat([Buffer.from(t), body]), privateKey).toString('hex')
    const headers: [string, string][] = [['x-signature-timestamp', t], ['x-signature-ed25519', signature]]
    expect(await verifyRequest(verification, request(headers), { secret: null, now: NOW })).toEqual({ ok: true })
    headers[1] = ['x-signature-ed25519', sign(null, Buffer.from('other'), privateKey).toString('hex')]
    expect(await verifyRequest(verification, request(headers), { secret: null, now: NOW })).toEqual({ ok: false, failure: { step: 'signature_mismatch' } })
  })

  test('ecdsa-p256 with a PEM key and a DER signature in base64', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const verification: WebhookVerification = {
      scheme: 'public_key', algorithm: 'ecdsa-p256', publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(), signedText: '{{body}}',
      signature: { source: { kind: 'header', name: 'x-sig' }, format: { encoding: 'base64' } },
    }
    const signature = sign('sha256', body, privateKey).toString('base64')
    expect(await verifyRequest(verification, request([['x-sig', signature]]), { secret: null, now: NOW })).toEqual({ ok: true })
  })
})

describe('token', () => {
  const verification: WebhookVerification = { scheme: 'token', source: { kind: 'header', name: 'x-gitlab-token' } }
  test('the header must equal the secret', async () => {
    expect(await verifyRequest(verification, request([['x-gitlab-token', 'shh']]), { secret, now: NOW })).toEqual({ ok: true })
    expect(await verifyRequest(verification, request([['x-gitlab-token', 'shh!']]), { secret, now: NOW })).toEqual({ ok: false, failure: { step: 'signature_mismatch' } })
  })
  test('the bearer token of Authorization', async () => {
    const bearer: WebhookVerification = { scheme: 'token', source: { kind: 'bearer' } }
    expect(await verifyRequest(bearer, request([['authorization', 'Bearer shh']]), { secret, now: NOW })).toEqual({ ok: true })
    expect(await verifyRequest(bearer, request([]), { secret, now: NOW })).toEqual({ ok: false, failure: { step: 'value_missing', detail: 'authorization' } })
  })
})

describe('jwt', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }
  const verification: WebhookVerification = { scheme: 'jwt', source: { kind: 'bearer' }, issuer: 'https://accounts.google.com', audience: 'https://host/hooks', jwksUrl: 'https://keys.test/jwks' }
  let fetches = 0
  const fetchImpl = async () => {
    fetches += 1
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })
  }
  function jwt(claims: { iss?: string; aud?: string; exp?: number }) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
    return `${header}.${payload}.${signature}`
  }
  beforeEach(() => {
    clearJwksCacheForTests()
    fetches = 0
  })

  test('a valid token passes and the keys are cached', async () => {
    const token = jwt({ iss: verification.scheme === 'jwt' ? verification.issuer : '', aud: 'https://host/hooks', exp: NOW / 1000 + 600 })
    expect(await verifyRequest(verification, request([['authorization', `Bearer ${token}`]]), { secret: null, now: NOW, fetchImpl })).toEqual({ ok: true })
    expect(await verifyRequest(verification, request([['authorization', `Bearer ${token}`]]), { secret: null, now: NOW, fetchImpl })).toEqual({ ok: true })
    expect(fetches).toBe(1)
  })

  test('a wrong claim names the claim', async () => {
    const wrongAudience = jwt({ iss: 'https://accounts.google.com', aud: 'other', exp: NOW / 1000 + 600 })
    expect(await verifyRequest(verification, request([['authorization', `Bearer ${wrongAudience}`]]), { secret: null, now: NOW, fetchImpl })).toEqual({ ok: false, failure: { step: 'jwt_invalid', detail: 'aud' } })
    const expired = jwt({ iss: 'https://accounts.google.com', aud: 'https://host/hooks', exp: NOW / 1000 - 600 })
    expect(await verifyRequest(verification, request([['authorization', `Bearer ${expired}`]]), { secret: null, now: NOW, fetchImpl })).toEqual({ ok: false, failure: { step: 'jwt_invalid', detail: 'exp' } })
  })

  test('no keys gives keys_unavailable', async () => {
    const down = async () => new Response('', { status: 503 })
    const token = jwt({ iss: 'https://accounts.google.com', aud: 'https://host/hooks', exp: NOW / 1000 + 600 })
    expect(await verifyRequest(verification, request([['authorization', `Bearer ${token}`]]), { secret: null, now: NOW, fetchImpl: down })).toEqual({ ok: false, failure: { step: 'keys_unavailable' } })
  })
})

describe('standard_webhooks', () => {
  const key = decodeStandardWebhooksSecret(`whsec_${Buffer.from('standard-secret').toString('base64')}`)
  test('a v1 signature over id.timestamp.body passes; an old one fails', async () => {
    const t = String(Math.floor(NOW / 1000))
    const signature = createHmac('sha256', key).update(`msg_1.${t}.${body}`).digest('base64')
    const headers: [string, string][] = [['webhook-id', 'msg_1'], ['webhook-timestamp', t], ['webhook-signature', `v1,bad v1,${signature}`]]
    expect(await verifyRequest({ scheme: 'standard_webhooks' }, request(headers), { secret: key, now: NOW })).toEqual({ ok: true })
    expect(await verifyRequest({ scheme: 'standard_webhooks' }, request(headers), { secret: key, now: NOW + 600_000 })).toEqual({ ok: false, failure: { step: 'timestamp_outside_tolerance' } })
    expect(await verifyRequest({ scheme: 'standard_webhooks' }, request(headers.slice(1)), { secret: key, now: NOW })).toEqual({ ok: false, failure: { step: 'value_missing', detail: 'webhook-id' } })
  })
})

describe('delivery proof (plan §2.5)', () => {
  const forwarderSecret = Buffer.from('forwarder')
  function headers(deliveryId: string, receivedAt: string, proof: string) {
    return new Map([['x-solus-hook-delivery-id', deliveryId], ['x-solus-hook-received-at', receivedAt], ['x-solus-hook-proof', proof]])
  }

  test('a valid proof gives the delivery ID and the receive time; a late one is held', () => {
    const receivedAt = String(NOW - 120_000)
    const proof = deliveryProof(forwarderSecret, 'host-1', 'wh-1', 'd-1', receivedAt)
    expect(readDeliveryProof({ headers: headers('d-1', receivedAt, proof), hostId: 'host-1', webhookId: 'wh-1', arrivedAt: NOW, forwarderSecret }))
      .toEqual({ deliveryId: 'd-1', receivedAt: NOW - 120_000, source: 'held' })
  })

  test('a receive time later than the arrival is clamped to the arrival', () => {
    const receivedAt = String(NOW + 5_000)
    const proof = deliveryProof(forwarderSecret, 'host-1', 'wh-1', 'd-1', receivedAt)
    expect(readDeliveryProof({ headers: headers('d-1', receivedAt, proof), hostId: 'host-1', webhookId: 'wh-1', arrivedAt: NOW, forwarderSecret }))
      .toEqual({ deliveryId: 'd-1', receivedAt: NOW, source: 'forwarded' })
  })

  test('without a valid proof the request is direct: an old received-at is ignored', () => {
    const receivedAt = String(NOW - 3_600_000)
    const forged = deliveryProof(Buffer.from('guess'), 'host-1', 'wh-1', 'd-1', receivedAt)
    expect(readDeliveryProof({ headers: headers('d-1', receivedAt, forged), hostId: 'host-1', webhookId: 'wh-1', arrivedAt: NOW, forwarderSecret }))
      .toEqual({ deliveryId: null, receivedAt: NOW, source: 'direct' })
    const otherWebhook = deliveryProof(forwarderSecret, 'host-1', 'wh-2', 'd-1', receivedAt)
    expect(readDeliveryProof({ headers: headers('d-1', receivedAt, otherWebhook), hostId: 'host-1', webhookId: 'wh-1', arrivedAt: NOW, forwarderSecret }).source).toBe('direct')
  })
})
