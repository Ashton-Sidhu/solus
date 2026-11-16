import { afterEach, describe, expect, test } from 'bun:test'
import { classifyConnectInput, pairTokenFromLocation, pairHostFromLocation, probeServer } from '../../apps/client/src/lib/connect'
import { hostedPairLink } from '@solus/client-core/pairing'
import { unreachableMessage } from '../../apps/client/src/lib/add-host'

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
  test('a hosted link names only a Tailscale HTTPS host', () => {
    const link = hostedPairLink('https://box.tail.ts.net:8443', 'tok')
    expect(pairTokenFromLocation(link)).toBe('tok')
    expect(pairHostFromLocation(link)).toBe('https://box.tail.ts.net:8443')
    expect(pairHostFromLocation('https://app.solus.sh/pair?host=evil.example#token=tok')).toBeNull()
  })
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
    respondWith({ ok: true, requireAuth: false, os: 'freebsd', name: 'newer' })
    const health = await probeServer('http://127.0.0.1:3000')
    expect(health.ok).toBe(true)
    expect(health.requireAuth).toBe(false)
    expect(health.os).toBeUndefined()
  })
})

describe('the add-host form says why a typed address gave no host (tailscale-support.md D2)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('the probe tells a failed request from a server that answered', async () => {
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    expect(await probeServer('http://100.64.0.2:3000')).toEqual({ ok: false, unreachable: 'other' })
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
    expect(await probeServer('http://100.64.0.2:3000')).toEqual({ ok: false })
  })

  test('a probe that runs out of time says so', async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })) as unknown as typeof fetch
    expect(await probeServer('http://100.64.0.2:3000', 0)).toEqual({ ok: false, unreachable: 'timeout' })
  })

  test('each reason gets its own message', () => {
    const url = 'http://100.64.0.2:3000'
    expect(unreachableMessage(url, { ok: false }, 'http:')).toContain('it is not a Solus host')
    expect(unreachableMessage(url, { ok: false, unreachable: 'other' }, 'https:')).toContain('served over https')
    expect(unreachableMessage(url, { ok: false, unreachable: 'timeout' }, 'http:')).toContain('Tailscale or your Wi-Fi')
    expect(unreachableMessage(url, { ok: false, unreachable: 'refused' }, 'http:')).toContain('often uses 3000')
    expect(unreachableMessage(url, { ok: false, unreachable: 'other' }, 'http:')).toContain('No Solus server answered')
  })
})
