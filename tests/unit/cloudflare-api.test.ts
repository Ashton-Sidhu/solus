import { afterEach, describe, expect, test } from 'bun:test'
import { verifyCloudflareToken } from '@solus/server/cloudflare/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('Cloudflare token verification', () => {
  test('returns accounts and expiry for an active token', async () => {
    globalThis.fetch = (async (url) => String(url).endsWith('/verify')
      ? response({ success: true, result: { id: 'token', status: 'active', expires_on: '2026-12-01T00:00:00Z' } })
      : response({ success: true, result: [{ id: 'account-1', name: 'Acme' }] })) as typeof fetch

    await expect(verifyCloudflareToken('token')).resolves.toEqual({
      kind: 'ok',
      accounts: [{ id: 'account-1', name: 'Acme' }],
      expiresOn: Date.parse('2026-12-01T00:00:00Z'),
    })
  })

  test('returns invalid for a rejected token', async () => {
    globalThis.fetch = (async () => response({ success: false }, 401)) as typeof fetch
    await expect(verifyCloudflareToken('token')).resolves.toEqual({ kind: 'invalid' })
  })

  test('returns network when a request fails', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
    await expect(verifyCloudflareToken('token')).resolves.toEqual({ kind: 'network' })
  })

  test('distinguishes a valid token that cannot list accounts', async () => {
    globalThis.fetch = (async (url) => String(url).endsWith('/verify')
      ? response({ success: true, result: { id: 'token', status: 'active' } })
      : response({ success: false }, 403)) as typeof fetch
    await expect(verifyCloudflareToken('token')).resolves.toEqual({ kind: 'accounts-forbidden' })
  })
})
