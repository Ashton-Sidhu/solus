import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPublicKey, verify } from 'crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CLIENT_ASSERTION_TYPE, CONTROL_AUDIENCE, HOST_CONTROL_SCOPE, SOLUS_API_CLIENT_ID, type HostPublicJwk } from '@solus/contracts/uplink'
import { HostCredentialError, clientCredential, forgetHostKey, generateHostKey, loadHostKey, saveHostKey } from '@solus/server/host/host-credential'
import { apiModeCredential, resetApiModeForTests } from '@solus/server/host/api-mode'

// docs/adr/0001-standard-authentication.md §2.2 rule 8, §3.4: a host has one
// credential, a key pair it made itself. It signs client assertions (RFC 7523) with
// the private half, which never leaves the machine, and gets its own control token
// with the client credentials grant. The Solus API holds the same kind of key (§6.2).

const TOKEN_ENDPOINT = 'https://account.test/api/auth/oauth2/token'

/** The claims of an assertion the public key verifies; null when the signature is not that key's. */
function verified(assertion: string, publicJwk: HostPublicJwk): { iss: string; sub: string; aud: string; jti: string; iat: number; exp: number } | null {
  const [header, body, signature] = assertion.split('.')
  if (!header || !body || !signature) return null
  const key = createPublicKey({ key: { ...publicJwk }, format: 'jwk' })
  if (!verify('sha256', Buffer.from(`${header}.${body}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))) return null
  expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toMatchObject({ alg: 'ES256' })
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
}

describe('the host credential', () => {
  test('an assertion is signed by the host’s key and names the client as issuer and subject, the audience, a one-time id, and one minute of life', async () => {
    const key = await generateHostKey()
    expect(key.publicJwk).not.toHaveProperty('d')
    const credential = clientCredential({ clientId: 'host_h1', privateJwk: key.privateJwk, tokenEndpoint: TOKEN_ENDPOINT, now: () => 1_700_000_000_000 })
    const first = verified(await credential.assertion(TOKEN_ENDPOINT), key.publicJwk)
    const second = verified(await credential.assertion(TOKEN_ENDPOINT), key.publicJwk)
    expect(first).toEqual({ iss: 'host_h1', sub: 'host_h1', aud: TOKEN_ENDPOINT, jti: expect.any(String), iat: 1_700_000_000, exp: 1_700_000_060 })
    expect(second?.jti).not.toBe(first?.jti)
    // Another key's public half does not verify it: the assertion proves this key only.
    const other = await generateHostKey()
    expect(verified(await credential.assertion(TOKEN_ENDPOINT), other.publicJwk)).toBeNull()
  })

  test('the control token is got with the client credentials grant and the key, and kept until a minute before its end', async () => {
    const key = await generateHostKey()
    let now = 1_000_000
    const forms: URLSearchParams[] = []
    const credential = clientCredential({
      clientId: 'host_h1', privateJwk: key.privateJwk, tokenEndpoint: TOKEN_ENDPOINT, now: () => now,
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe(TOKEN_ENDPOINT)
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        forms.push(init?.body as URLSearchParams)
        return Response.json({ access_token: `control-${forms.length}`, expires_in: 300, token_type: 'Bearer' })
      },
    })
    // Callers at the same moment share one request.
    expect(await Promise.all([credential.hostAccessToken(), credential.hostAccessToken()])).toEqual(['control-1', 'control-1'])
    now += 239_000
    expect(await credential.hostAccessToken()).toBe('control-1')
    now += 2_000
    expect(await credential.hostAccessToken()).toBe('control-2')
    expect(forms).toHaveLength(2)
    const form = forms[0]!
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('resource')).toBe(CONTROL_AUDIENCE)
    expect(form.get('scope')).toBe(HOST_CONTROL_SCOPE)
    expect(form.get('client_id')).toBe('host_h1')
    expect(form.get('client_assertion_type')).toBe(CLIENT_ASSERTION_TYPE)
    expect(verified(form.get('client_assertion')!, key.publicJwk)).toMatchObject({ iss: 'host_h1', aud: TOKEN_ENDPOINT })
  })

  test('a refused key and an unreachable account plane are told apart', async () => {
    const key = await generateHostKey()
    let answer: () => Response = () => Response.json({ error: 'invalid_client', error_description: 'client assertion signature verification failed' }, { status: 401 })
    const credential = clientCredential({ clientId: 'host_h1', privateJwk: key.privateJwk, tokenEndpoint: TOKEN_ENDPOINT, fetchImpl: async () => answer() })
    await expect(credential.hostAccessToken()).rejects.toMatchObject({ code: 'refused' })
    answer = () => new Response('down', { status: 503 })
    await expect(credential.hostAccessToken()).rejects.toMatchObject({ code: 'unreachable' })
    answer = () => { throw new TypeError('fetch failed') }
    const error = await credential.hostAccessToken().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HostCredentialError)
    expect(error).toMatchObject({ code: 'unreachable' })
  })
})

describe('the host key in the secret store', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-host-credential-'))
    process.env.SOLUS_DATA_DIR = dataDir
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('the key is kept with its client and registration generation, survives a restart, and goes with the registration', async () => {
    const key = await generateHostKey()
    expect(loadHostKey()).toBeNull()
    saveHostKey({ clientId: 'host_h1', generation: 3, privateJwk: key.privateJwk })
    expect(loadHostKey()).toEqual({ version: 1, clientId: 'host_h1', generation: 3, privateJwk: key.privateJwk })
    // The standalone server's secret store is a file only it may read.
    expect(JSON.parse(readFileSync(join(dataDir, 'secrets', 'host-credential.json'), 'utf8')).privateJwk.d).toBe(key.privateJwk.d)
    forgetHostKey()
    expect(loadHostKey()).toBeNull()
  })
})

describe('the Solus API’s service credential', () => {
  const saved = { SOLUS_API: process.env.SOLUS_API, SOLUS_CLOUD_ISSUER: process.env.SOLUS_CLOUD_ISSUER, SOLUS_CLOUD_JWKS_URL: process.env.SOLUS_CLOUD_JWKS_URL }
  beforeEach(() => {
    resetApiModeForTests()
    Object.assign(process.env, { SOLUS_API: '1', SOLUS_CLOUD_ISSUER: 'https://account.test', SOLUS_CLOUD_JWKS_URL: 'https://account.test/api/auth/jwks' })
  })
  afterEach(() => {
    resetApiModeForTests()
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  test('is the solus-api client with the configured key, at the issuer’s token endpoint, and leaves the environment', async () => {
    // WHY: processes this one starts inherit its environment; the key must not travel with them.
    const key = await generateHostKey()
    const env: { SOLUS_API_CLIENT_KEY?: string } = { SOLUS_API_CLIENT_KEY: JSON.stringify(key.privateJwk) }
    const credential = apiModeCredential(env)
    expect(env.SOLUS_API_CLIENT_KEY).toBeUndefined()
    expect(credential).toMatchObject({ clientId: SOLUS_API_CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT })
    expect(verified(await credential!.assertion(TOKEN_ENDPOINT), key.publicJwk)).toMatchObject({ iss: SOLUS_API_CLIENT_ID, sub: SOLUS_API_CLIENT_ID })
  })

  test('none configured reads nobody’s account; a value that is not a private P-256 key fails at start', () => {
    expect(apiModeCredential({})).toBeNull()
    resetApiModeForTests()
    expect(() => apiModeCredential({ SOLUS_API_CLIENT_KEY: '{"kty":"EC","crv":"P-256","x":"a","y":"b"}' })).toThrow(/private ES256 JWK/)
  })
})
