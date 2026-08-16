import { afterEach, describe, expect, test } from 'bun:test'
import { claimServer, pairServer } from '../../src/client-core/pairing'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function respondWith(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as typeof fetch
}

describe('pairing handshake decoding', () => {
  test('pairs against a newer server whose optional fields reshaped', async () => {
    // WHY: dispatch-client step 1 skew-safety — an unknown `os` value used to
    // throw out of the response parse, so the user could never pair with a
    // newer host even though the session token decoded fine.
    respondWith({ sessionToken: 'tok', installationId: 'inst-1', os: 'freebsd' })

    const result = await pairServer({
      url: 'http://host.example',
      pairToken: 'pair',
      deviceLabel: 'Test device',
    })

    expect(result.sessionToken).toBe('tok')
    expect(result.server.installationId).toBe('inst-1')
    expect(result.server.os).toBeUndefined()
  })

  test('claims a fresh server despite an unknown os value', async () => {
    respondWith({
      ok: true,
      sessionToken: 'tok',
      ownerDeviceId: 'dev-1',
      claimedAt: 5,
      installationId: 'inst-2',
      fingerprint: 'fp',
      os: 'freebsd',
    })

    const result = await claimServer({
      url: 'http://host.example',
      code: '123456',
      deviceLabel: 'Test device',
    })

    expect(result.sessionToken).toBe('tok')
    expect(result.server.os).toBeUndefined()
  })

  test('a structured error body degrades to the status message, not a decode throw', async () => {
    // The server's real failure reason must never be replaced by a zod error
    // about the shape of the failure.
    respondWith({ error: { code: 'expired', detail: 'pair token expired' } }, 403)

    await expect(
      pairServer({ url: 'http://host.example', pairToken: 'p', deviceLabel: 'd' }),
    ).rejects.toThrow('Pair failed (403)')
  })

  test('a missing session token is reported as such even when the body is not JSON', async () => {
    globalThis.fetch = (async () => new Response('<html>proxy error</html>', { status: 200 })) as typeof fetch

    await expect(
      pairServer({ url: 'http://host.example', pairToken: 'p', deviceLabel: 'd' }),
    ).rejects.toThrow('Pair response did not include a session token')
  })

  test('rejects a pair response without the host identity', async () => {
    // WHY: a generated registry id was a compatibility path that disabled
    // identity checks. A paired host must now name its stable installation.
    respondWith({ sessionToken: 'tok' })

    await expect(
      pairServer({ url: 'http://host.example', pairToken: 'p', deviceLabel: 'd' }),
    ).rejects.toThrow('Pair response did not include an installation id')
  })
})
