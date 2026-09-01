import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'
import type { SecretStore } from '@solus/server/platform/secrets'
import type { AtlassianStoredCredential } from '@solus/server/atlassian/token-store'

/**
 * The shared Atlassian transport under load: how many calls it lets out at once,
 * and what it does when Atlassian says "too many".
 *
 * Both matter for one reason — Jira rate limits per user, so a fan-out that
 * ignores the limit does not fail one request, it fails the connection for
 * every linked task at once.
 */

const credential: AtlassianStoredCredential = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 600_000,
  cloudId: 'cloud-1',
  siteUrl: 'https://example.atlassian.net',
  products: ['jira', 'confluence'],
  scopes: [],
}

// The credential is supplied through the secret store rather than by mocking
// `currentCredential`, so the real read path runs — and so this file does not
// replace a module every other Atlassian test depends on. Bun's module mocks
// are process-wide.
const store: SecretStore = {
  // SAFETY: the only record is the credential written on the line below.
  loadJson: <T>() => credential as T,
  saveJson: () => {},
  remove: () => {},
  canSave: () => true,
}
mock.module('@solus/server/platform/secrets', () => ({ secretStore: () => store }))

let api: typeof import('@solus/server/atlassian/api')
const originalFetch = globalThis.fetch

beforeAll(async () => {
  api = await import('@solus/server/atlassian/api')
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(handler: (url: string | URL | Request) => Promise<Response>): void {
  // SAFETY: the transport calls fetch only as `fetch(url, init)` and reads `ok`,
  // `status`, `headers` and `json()` off the result — all this stub provides.
  globalThis.fetch = handler as typeof fetch
}

function ok(): Response {
  return new Response(JSON.stringify({ value: 1 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const bodySchema = z.object({ value: z.number() })

function request(): Promise<{ value: number }> {
  return api.atlassianRequest(
    { product: 'jira', cloudId: 'cloud-1', path: '/rest/api/3/myself' },
    bodySchema,
  )
}

describe('Atlassian multipart writes', () => {
  // Attachments are the one multipart write. Atlassian refuses a multipart
  // request without its XSRF opt-out header, and a JSON content type on a
  // form body would drop the boundary `fetch` derives — so the transport has
  // to know the difference, not the caller.
  test('sends a FormData body as multipart with the XSRF header', async () => {
    let sent: RequestInit | undefined
    stubFetch(((_url: string | URL | Request, init?: RequestInit) => {
      sent = init
      return Promise.resolve(ok())
    }) as typeof fetch)

    const form = new FormData()
    form.append('file', new Blob(['bytes'], { type: 'image/png' }), 'still.png')
    await api.atlassianRequest(
      { product: 'jira', cloudId: 'cloud-1', method: 'POST', path: '/rest/api/3/issue/ACME-1/attachments', body: form },
      bodySchema,
    )

    expect(sent?.body).toBe(form)
    const headers = new Headers(sent?.headers)
    expect(headers.get('x-atlassian-token')).toBe('no-check')
    expect(headers.get('content-type')).toBeNull()
    expect(headers.get('authorization')).toBe('Bearer access-1')
  })

  test('a JSON body still goes as JSON', async () => {
    let sent: RequestInit | undefined
    stubFetch(((_url: string | URL | Request, init?: RequestInit) => {
      sent = init
      return Promise.resolve(ok())
    }) as typeof fetch)

    await api.atlassianRequest(
      { product: 'jira', cloudId: 'cloud-1', method: 'POST', path: '/rest/api/3/issue', body: { fields: {} } },
      bodySchema,
    )

    expect(sent?.body).toBe('{"fields":{}}')
    expect(new Headers(sent?.headers).get('content-type')).toBe('application/json')
    expect(new Headers(sent?.headers).get('x-atlassian-token')).toBeNull()
  })
})

describe('Atlassian transport under load', () => {
  // Importing a hundred tickets used to open a hundred sockets at once. The cap
  // is what turns every fan-out in Solus into a paced queue without each call
  // site having to know it is one of many.
  test('holds concurrent calls to a fixed ceiling', async () => {
    let open = 0
    let peak = 0
    stubFetch(async () => {
      open++
      peak = Math.max(peak, open)
      await new Promise((resolve) => setTimeout(resolve, 5))
      open--
      return ok()
    })

    await Promise.all(Array.from({ length: 40 }, () => request()))

    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(5)
  })

  // A 429 answered as an ordinary error marks the link failed and moves on. The
  // request is not wrong, it is early — so it is retried after the wait
  // Atlassian named, and the caller never sees the refusal.
  test('waits the interval Atlassian asks for, then retries once', async () => {
    let attempts = 0
    const startedAt = Date.now()
    stubFetch(async () => {
      attempts++
      if (attempts === 1) {
        return new Response('', { status: 429, headers: { 'retry-after': '1' } })
      }
      return ok()
    })

    await expect(request()).resolves.toEqual({ value: 1 })
    expect(attempts).toBe(2)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900)
  })

  // A second refusal is a real one. Reporting it as "HTTP 429" would put a bare
  // status code on a task card; the user's only useful action is to wait, so say
  // that. (The reset time is already in the past, which means "no wait left" and
  // keeps this test from paying the default cool-down.)
  test('names rate limiting when the retry is refused too', async () => {
    stubFetch(async () => new Response('', {
      status: 429,
      headers: { 'x-ratelimit-reset': new Date(Date.now() - 60_000).toISOString() },
    }))

    await expect(request()).rejects.toThrow(/rate limiting/i)
  })
})
