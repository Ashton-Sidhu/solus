import { afterEach, describe, expect, test } from 'bun:test'
import { classifyConnectInput, pairTokenFromLocation, probeServer } from '../../client/src/lib/connect'

describe('classifyConnectInput', () => {
  test('a full pairing link pairs directly, with the token from the fragment', () => {
    const input = classifyConnectInput('http://192.168.1.42:51234/pair#token=abc123')
    expect(input).toEqual({ kind: 'link', url: 'http://192.168.1.42:51234', pairToken: 'abc123' })
  })

  test('a bare address still needs its code, and gains a scheme', () => {
    expect(classifyConnectInput('192.168.1.42:51234')).toEqual({
      kind: 'address',
      url: 'http://192.168.1.42:51234',
    })
  })

  test('an https address keeps its scheme', () => {
    expect(classifyConnectInput('https://solus.example.com')).toEqual({
      kind: 'address',
      url: 'https://solus.example.com',
    })
  })

  test('whitespace-only input is empty, not an address', () => {
    expect(classifyConnectInput('   ')).toEqual({ kind: 'empty' })
  })

  test('a URL without a token is an address, so the code field appears', () => {
    // Pasting the server root (or a copied browser URL) must not be mistaken
    // for a pairing link — there is no token to pair with.
    expect(classifyConnectInput('http://192.168.1.42:51234/pair')).toEqual({
      kind: 'address',
      url: 'http://192.168.1.42:51234/pair',
    })
  })
})

describe('pairTokenFromLocation', () => {
  test('extracts the token when the SPA is opened at /pair', () => {
    expect(pairTokenFromLocation('http://192.168.1.42:51234/pair#token=tok')).toBe('tok')
  })

  test('any other path never auto-pairs, token or not', () => {
    // Only /pair means "this link IS the handshake"; a token fragment on
    // another route (e.g. copied into the app root) must go through the form.
    expect(pairTokenFromLocation('http://192.168.1.42:51234/#token=tok')).toBeNull()
    expect(pairTokenFromLocation('http://192.168.1.42:51234/pair')).toBeNull()
  })

  test('garbage input is null, not a throw — this runs on every boot', () => {
    expect(pairTokenFromLocation('not a url')).toBeNull()
  })
})

describe('probeServer auth advertisement', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function respondWith(body: object): void {
    globalThis.fetch = (async () => new Response(JSON.stringify(body))) as typeof fetch
  }

  test('surfaces requireAuth:false — the only answer that permits silent auto-connect', async () => {
    respondWith({ ok: true, requireAuth: false, name: 'dev box' })
    const health = await probeServer('http://127.0.0.1:3000')
    expect(health.ok).toBe(true)
    expect(health.requireAuth).toBe(false)
  })

  test('an older server that omits the field is not mistaken for an open one', async () => {
    // Boot auto-connects only on an explicit `requireAuth === false`; a health
    // payload from before the field existed must leave it undefined.
    respondWith({ ok: true, name: 'old server' })
    const health = await probeServer('http://127.0.0.1:3000')
    expect(health.ok).toBe(true)
    expect(health.requireAuth).toBeUndefined()
  })

  test('a newer server with a reshaped field still probes ok', async () => {
    // WHY: skew-safety (dispatch-client step 1). One additive value (e.g. a
    // new `os`) used to fail the whole probe, which broke zero-ceremony boot
    // and sent claimable hosts down the wrong pairing path.
    respondWith({ ok: true, requireAuth: false, claimable: true, os: 'freebsd', name: 'newer' })
    const health = await probeServer('http://127.0.0.1:3000')
    expect(health.ok).toBe(true)
    expect(health.requireAuth).toBe(false)
    expect(health.claimable).toBe(true)
    expect(health.os).toBeUndefined()
  })
})
