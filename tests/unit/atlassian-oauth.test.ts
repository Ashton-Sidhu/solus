import { afterEach, beforeAll, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import type { SecretStore } from '@solus/server/platform/secrets'

const records = new Map<string, unknown>()
const store: SecretStore = {
  // SAFETY: every record was written by this file's own saveJson, so the value
  // read back is the one the matching load expects.
  loadJson: <T>(key: string) => (records.get(key) as T | undefined) ?? null,
  saveJson: (key: string, _path: string, value: unknown) => { records.set(key, value) },
  remove: (key: string) => { records.delete(key) },
  canSave: () => true,
}
const originalFetch = globalThis.fetch

mock.module('@solus/server/platform/secrets', () => ({ secretStore: () => store }))
mock.module('@solus/server/atlassian/client-id', () => ({ ATLASSIAN_CLIENT_ID: 'test-client' }))
mock.module('@solus/server/atlassian/client-secret', () => ({ ATLASSIAN_CLIENT_SECRET: 'test-secret' }))

let oauth: typeof import('@solus/server/atlassian/oauth')
let tokenStore: typeof import('@solus/server/atlassian/token-store')

beforeAll(async () => {
  oauth = await import('@solus/server/atlassian/oauth')
  tokenStore = await import('@solus/server/atlassian/token-store')
})

beforeEach(() => { records.clear() })
afterEach(() => {
  jest.useRealTimers()
  globalThis.fetch = originalFetch
  // The flow binds a fixed port; leaving it bound would fail the next test.
  oauth.cancelOAuthFlow()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Every test drives the code under test through this one stub. */
function stubFetch(handler: (url: string | URL | Request) => Promise<Response>): void {
  // SAFETY: the code under test calls fetch only as `fetch(url, init)` and reads
  // `ok`, `status`, and `json()` off the result — all this stub provides.
  globalThis.fetch = handler as typeof fetch
}

/** Pulls the state out of a freshly started flow, as the browser would. */
async function startAndReadState(): Promise<string> {
  const started = await startOAuthWithoutPort()
  // SAFETY: startOAuthFlow always sets state; a missing one would fail the
  // assertions below rather than pass silently.
  return new URL(started.authUrl).searchParams.get('state')!
}

function startOAuthWithoutPort() {
  return oauth.startOAuthFlow({ listenForCallback: async () => {} })
}

describe('Atlassian OAuth state', () => {
  // Atlassian matches the callback character for character, so the URL the
  // flow asks for must be exactly the one registered with the app.
  test('asks for the one registered loopback callback', async () => {
    const authUrl = new URL((await startOAuthWithoutPort()).authUrl)
    expect(authUrl.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${oauth.CALLBACK_PORT}/oauth/atlassian/callback`)
    expect(oauth.REGISTERED_REDIRECT_URI).toBe(authUrl.searchParams.get('redirect_uri'))
  })

  test('requests offline access, or the grant would die within the hour', async () => {
    const authUrl = new URL((await startOAuthWithoutPort()).authUrl)
    expect(authUrl.searchParams.get('scope')).toContain('offline_access')
    expect(authUrl.searchParams.get('audience')).toBe('api.atlassian.com')
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authUrl.searchParams.get('redirect_uri')).toBe(oauth.REGISTERED_REDIRECT_URI)
  })

  test('asks for granular Confluence scopes, because the v2 API refuses classic ones', async () => {
    const scope = new URL((await startOAuthWithoutPort()).authUrl).searchParams.get('scope') ?? ''
    // Page and space CRUD runs on /wiki/api/v2, which answers a classic scope
    // with `401 Unauthorized; scope does not match` — indistinguishable from a
    // dead token unless the right scope is requested up front.
    expect(scope).toContain('read:space:confluence')
    expect(scope).toContain('read:page:confluence')
    expect(scope).toContain('write:page:confluence')
    // CQL search has no v2 endpoint, so its classic scope has to survive too.
    expect(scope).toContain('search:confluence')
  })

  test('a callback whose state was never issued is refused', async () => {
    const outcome = await oauth.completeOAuthCallback(new URLSearchParams({ state: 'never-issued-state', code: 'c' }))
    expect(outcome.kind).toBe('expired')
  })

  test('a state cannot be replayed once it has been spent', async () => {
    const state = await startAndReadState()
    stubFetch((async () => json({}, 500)))
    await oauth.completeOAuthCallback(new URLSearchParams({ state, code: 'c' }))
    const replay = await oauth.completeOAuthCallback(new URLSearchParams({ state, code: 'c' }))
    expect(replay.kind).toBe('expired')
  })

  test('a user who declines is reported as denied, not as a failure', async () => {
    const state = await startAndReadState()
    const outcome = await oauth.completeOAuthCallback(new URLSearchParams({ state, error: 'access_denied' }))
    expect(outcome.kind).toBe('denied')
  })
})

describe('Atlassian OAuth callback port', () => {
  // The listener is injected here so unit files never compete for the fixed
  // production port when Bun schedules them in parallel.
  test('reports the port as busy rather than failing obscurely', async () => {
    await expect(oauth.startOAuthFlow({
      listenForCallback: async () => { throw new oauth.AtlassianCallbackPortBusyError() },
    })).rejects.toThrow(oauth.AtlassianCallbackPortBusyError)
  })

  test('a second sign-in supersedes the first instead of colliding with it', async () => {
    const firstState = await startAndReadState()
    await expect(startOAuthWithoutPort()).resolves.toMatchObject({ authUrl: expect.any(String) })

    const staleCallback = await oauth.completeOAuthCallback(
      new URLSearchParams({ state: firstState, code: 'old-tab-code' }),
    )
    expect(staleCallback.kind).toBe('expired')
  })

  test('reports expiry to the client which is waiting for the browser', async () => {
    jest.useFakeTimers()
    const events: Array<{ connected: boolean; error?: string }> = []
    oauth.setOAuthCompletedListener((event) => events.push(event))
    await startOAuthWithoutPort()

    jest.advanceTimersByTime(5 * 60_000)

    expect(events).toEqual([{
      connected: false,
      error: 'The Atlassian sign-in expired. Try again.',
    }])
  })

  test('cancelling frees the port for the next attempt', async () => {
    await startOAuthWithoutPort()
    oauth.cancelOAuthFlow()
    await expect(startOAuthWithoutPort()).resolves.toMatchObject({ authUrl: expect.any(String) })
  })
})

describe('Atlassian OAuth grant', () => {
  test('stores the cloudId and the products the granted scopes actually reach', async () => {
    const state = await startAndReadState()
    stubFetch((async (url) => String(url).includes('accessible-resources')
      ? json([{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'Acme' }])
      : json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: 'read:jira-work offline_access',
        })))

    const outcome = await oauth.completeOAuthCallback(new URLSearchParams({ state, code: 'auth-code' }))
    expect(outcome).toMatchObject({ kind: 'connected', siteUrl: 'https://acme.atlassian.net' })

    const stored = tokenStore.loadCredential()
    expect(stored).toMatchObject({
      cloudId: 'cloud-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      // Confluence was not granted, so it must not be offered.
      products: ['jira'],
    })
  })

  // Atlassian refuses without a site, and a connection to nothing is worse than
  // no connection: every later call would fail with no way to explain why.
  test('refuses to store a grant for an account with no Atlassian site', async () => {
    const state = await startAndReadState()
    stubFetch((async (url) => String(url).includes('accessible-resources')
      ? json([])
      : json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'read:jira-work' })))

    expect((await oauth.completeOAuthCallback(new URLSearchParams({ state, code: 'c' }))).kind).toBe('no-sites')
    expect(records.size).toBe(0)
  })

  test('refuses a grant with no refresh token rather than storing one that dies', async () => {
    const state = await startAndReadState()
    stubFetch((async () => json({ access_token: 'a', expires_in: 3600 })))
    expect((await oauth.completeOAuthCallback(new URLSearchParams({ state, code: 'c' }))).kind).toBe('failed')
    expect(records.size).toBe(0)
  })

  // Without the reason, a rejection is undiagnosable: an expired grant and a
  // mismatched client secret produce byte-identical messages. This one reaches
  // the user directly — it is printed on the page the browser lands on.
  test('repeats the reason Atlassian gave for refusing the exchange', async () => {
    const state = await startAndReadState()
    stubFetch((async () => json(
      { error: 'invalid_client', error_description: 'Client authentication failed.' },
      400,
    )))

    const outcome = await oauth.completeOAuthCallback(new URLSearchParams({ state, code: 'c' }))

    expect(outcome.kind).toBe('failed')
    const reason = outcome.kind === 'failed' ? outcome.error : ''
    expect(reason).toContain('invalid_client')
    expect(reason).toContain('Client authentication failed.')
  })
})

describe('Atlassian token refresh', () => {
  const expiredCredential = {
    siteUrl: 'https://acme.atlassian.net',
    cloudId: 'cloud-1',
    products: ['jira' as const],
    accessToken: 'stale',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() - 1000,
    scopes: ['read:jira-work', 'offline_access'],
  }

  // Atlassian rotates the refresh token on every use and invalidates the old
  // one. Keeping the old one silently loses the grant at the next refresh.
  test('persists the rotated refresh token, not just the new access token', async () => {
    records.set('atlassian-oauth', expiredCredential)
    stubFetch((async () => json({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 3600,
    })))

    const refreshed = await oauth.currentCredential()
    expect(refreshed).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' })
    expect(records.get('atlassian-oauth')).toMatchObject({ refreshToken: 'refresh-2' })
  })

  // The rotation above is exactly why concurrency is dangerous here: a second
  // refresh spends a token Atlassian has already invalidated, is answered
  // `invalid_grant`, and the 4xx rule then throws the whole connection away. A
  // poll of many linked tickets, or one import, is enough to arrange that.
  test('a burst of callers on an expired token spends one refresh, not one each', async () => {
    records.set('atlassian-oauth', expiredCredential)
    let refreshes = 0
    stubFetch((async () => {
      refreshes++
      // Rotate as Atlassian does: a second use of `refresh-1` would fail.
      return json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 })
    }))

    const callers = await Promise.all(
      Array.from({ length: 8 }, () => oauth.currentCredential()),
    )

    expect(refreshes).toBe(1)
    expect(callers.every((credential) => credential?.accessToken === 'access-2')).toBe(true)
    expect(records.get('atlassian-oauth')).toMatchObject({ refreshToken: 'refresh-2' })
  })

  // The shared promise must not outlive the refresh, or the next expiry would
  // be answered with the result of the previous one.
  test('refreshes again once the shared attempt has settled', async () => {
    records.set('atlassian-oauth', expiredCredential)
    let refreshes = 0
    stubFetch((async () => {
      refreshes++
      return json({ access_token: `access-${refreshes}`, refresh_token: 'refresh-2', expires_in: 0 })
    }))

    await oauth.currentCredential()
    await oauth.currentCredential()

    expect(refreshes).toBe(2)
  })

  test('does not spend a refresh on a token that is still good', async () => {
    records.set('atlassian-oauth', { ...expiredCredential, expiresAt: Date.now() + 600_000 })
    let refreshed = false
    stubFetch((async () => { refreshed = true; return json({}) }))

    await expect(oauth.currentCredential()).resolves.toMatchObject({ accessToken: 'stale' })
    expect(refreshed).toBe(false)
  })

  // A refresh that fails leaves no usable credential. Returning the stale one
  // would send every later call into a 401 with no way to explain why.
  test('answers null when the grant can no longer be refreshed', async () => {
    records.set('atlassian-oauth', expiredCredential)
    stubFetch((async () => json({ error: 'invalid_grant' }, 400)))
    await expect(oauth.currentCredential()).resolves.toBeNull()
  })

  // A refresh token rotates on every use, so one Atlassian has refused can
  // never be retried. Keeping it leaves every surface reporting a connection
  // that cannot make a single call — which is how an expired grant showed up as
  // an empty Jira project list instead of a prompt to sign in again.
  test('discards a grant Atlassian rejects outright', async () => {
    records.set('atlassian-oauth', expiredCredential)
    stubFetch((async () => json({ error: 'invalid_grant' }, 400)))

    await oauth.currentCredential()

    expect(records.get('atlassian-oauth')).toBeUndefined()
  })

  // The opposite failure: a server that is briefly down must not cost the user
  // their connection, because the grant is still perfectly good.
  test('keeps the grant when the refresh only failed to reach Atlassian', async () => {
    records.set('atlassian-oauth', expiredCredential)
    stubFetch((async () => { throw new Error('network down') }))

    await expect(oauth.currentCredential()).resolves.toBeNull()

    expect(records.get('atlassian-oauth')).toMatchObject({ refreshToken: 'refresh-1' })
  })

  test('keeps the grant when Atlassian itself is failing', async () => {
    records.set('atlassian-oauth', expiredCredential)
    stubFetch((async () => json({ error: 'server_error' }, 503)))

    await expect(oauth.currentCredential()).resolves.toBeNull()

    expect(records.get('atlassian-oauth')).toMatchObject({ refreshToken: 'refresh-1' })
  })

})

describe('Atlassian OAuth availability', () => {
  // The renderer offers the browser button from this flag alone. A build with
  // no client credentials must fall back to the token form rather than opening
  // a sign-in that cannot complete.
  test('a build with client credentials advertises the browser flow', () => {
    expect(oauth.isOAuthConfigured()).toBe(true)
  })

  // The unconfigured case needs different build constants, so it lives in
  // atlassian-oauth-unconfigured.test.ts — bun's module mocks are process-wide.
})
