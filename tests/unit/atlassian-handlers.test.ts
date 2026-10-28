import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import type { SecretStore } from '@solus/server/platform/secrets'

/**
 * The RPC surface with an OAuth client configured. The unconfigured build is
 * covered in atlassian-oauth-unconfigured.test.ts, because bun's module mocks
 * are process-wide and the two need different build constants.
 */

const records = new Map<string, unknown>()
const store: SecretStore = {
  // SAFETY: every record was written by this file's own saveJson, so the value
  // read back is the one the matching load expects.
  loadJson: <T>(key: string) => (records.get(key) as T | undefined) ?? null,
  saveJson: (key: string, _path: string, value: unknown) => { records.set(key, value) },
  remove: (key: string) => { records.delete(key) },
  canSave: () => true,
}

mock.module('@solus/server/platform/secrets', () => ({ secretStore: () => store }))
mock.module('@solus/server/atlassian/client-id', () => ({ ATLASSIAN_CLIENT_ID: 'test-client' }))
mock.module('@solus/server/atlassian/client-secret', () => ({ ATLASSIAN_CLIENT_SECRET: 'test-secret' }))

let SolusServer: typeof import('@solus/server/transport/server')['SolusServer']
let registerAtlassianHandlers: typeof import('@solus/server/transport/handlers/atlassian-handlers')['registerAtlassianHandlers']
let connectWithApiToken: typeof import('@solus/server/atlassian/api-token')['connectWithApiToken']
beforeAll(async () => {
  ;({ SolusServer } = await import('@solus/server/transport/server'))
  ;({ registerAtlassianHandlers } = await import('@solus/server/transport/handlers/atlassian-handlers'))
  ;({ connectWithApiToken } = await import('@solus/server/atlassian/api-token'))
})

beforeEach(() => {
  records.clear()
})

function server(): InstanceType<typeof SolusServer> {
  const instance = new SolusServer()
  registerAtlassianHandlers(instance, {
    cancelOAuthFlow: () => {},
    connectWithApiToken,
    isOAuthConfigured: () => true,
    startOAuthFlow: async () => ({
      authUrl: 'https://auth.atlassian.com/authorize?state=test-state',
      expiresAt: Date.now() + 300_000,
    }),
  })
  return instance
}

const storedGrant = {
  siteUrl: 'https://acme.atlassian.net',
  cloudId: 'cloud-1',
  siteName: 'Acme',
  products: ['jira', 'confluence'],
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 3600_000,
  scopes: ['read:jira-work', 'offline_access'],
}

describe('Atlassian RPC handlers', () => {
  test('reports disconnected for a clean host, and that signing in is possible', async () => {
    await expect(server().handle('atlassianStatus', [], TEST_HANDLER_CTX)).resolves.toEqual({
      connected: false,
      oauthAvailable: true,
      apiTokenAvailable: true,
    })
  })

  test('reports the site a stored grant reaches', async () => {
    records.set('atlassian-oauth', storedGrant)
    await expect(server().handle('atlassianStatus', [], TEST_HANDLER_CTX)).resolves.toEqual({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      cloudId: 'cloud-1',
      siteName: 'Acme',
      products: ['jira', 'confluence'],
      oauthAvailable: true,
      apiTokenAvailable: true,
      authMethod: 'oauth',
    })
  })

  // The status is the renderer's only view of the connection, and no credential
  // material may reach it — the browser flow keeps tokens on the host.
  test('never puts token material in the status', async () => {
    records.set('atlassian-oauth', storedGrant)
    const status = JSON.stringify(await server().handle('atlassianStatus', [], TEST_HANDLER_CTX))
    expect(status).not.toContain('access-1')
    expect(status).not.toContain('refresh-1')
  })

  test('starting a sign-in yields an Atlassian authorize URL', async () => {
    await expect(server().handle('atlassianStartOAuth', [], TEST_HANDLER_CTX)).resolves.toMatchObject({
      ok: true,
      authUrl: expect.stringContaining('https://auth.atlassian.com/authorize?'),
    })
  })

  // Disconnect drops Solus's copy only; revoking at Atlassian is the user's to
  // do. It must also release the port, or an abandoned sign-in blocks the next.
  test('disconnect clears the stored grant', async () => {
    records.set('atlassian-oauth', storedGrant)
    const instance = server()
    await instance.handle('atlassianDisconnect', [], TEST_HANDLER_CTX)

    expect(records.size).toBe(0)
    await expect(instance.handle('atlassianStatus', [], TEST_HANDLER_CTX)).resolves.toMatchObject({ connected: false })
  })

  test('cancelling frees the callback port for the next attempt', async () => {
    const instance = server()
    await instance.handle('atlassianStartOAuth', [], TEST_HANDLER_CTX)
    await instance.handle('atlassianCancelOAuth', [], TEST_HANDLER_CTX)
    await expect(instance.handle('atlassianStartOAuth', [], TEST_HANDLER_CTX)).resolves.toMatchObject({ ok: true })
  })
})

/**
 * The fallback: a token the user pastes. It is kept only once Atlassian accepts
 * it, and it must be spent the way it was accepted — a classic token against
 * the site, a scoped one through the gateway.
 */
describe('Atlassian API token connection', () => {
  const originalFetch = globalThis.fetch
  const basic = `Basic ${Buffer.from('me@acme.com:token-1').toString('base64')}`
  const input = { siteUrl: 'acme', email: ' me@acme.com ', apiToken: 'token-1\n' }

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  /** Answers tenant_info, and 200 for the probe URLs in `accepted` sent with the right header. */
  function stubAtlassian(accepted: string[]): string[] {
    const calls: string[] = []
    // SAFETY: the connect step calls fetch only as `fetch(url, init)` and reads `ok` and `json()`.
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url)
      calls.push(href)
      if (href === 'https://acme.atlassian.net/_edge/tenant_info') return Response.json({ cloudId: 'cloud-9' })
      const authorized = new Headers(init?.headers).get('authorization') === basic
      return authorized && accepted.some((prefix) => href.startsWith(prefix))
        ? Response.json({ values: [{ key: 'ACME', name: 'Acme' }] })
        : new Response(null, { status: 401 })
    }) as typeof fetch
    return calls
  }

  test('a classic token connects against the site and is spent there', async () => {
    const calls = stubAtlassian(['https://acme.atlassian.net/rest/'])
    const instance = server()

    await expect(instance.handle('atlassianConnectApiToken', [input], TEST_HANDLER_CTX)).resolves.toEqual({ ok: true })
    const status = await instance.handle('atlassianStatus', [], TEST_HANDLER_CTX)
    expect(status).toMatchObject({ connected: true, cloudId: 'cloud-9', products: ['jira'], authMethod: 'apiToken' })
    expect(JSON.stringify(status)).not.toContain('token-1')

    await expect(instance.handle('atlassianJiraProjects', [], TEST_HANDLER_CTX)).resolves.toEqual([{ key: 'ACME', name: 'Acme' }])
    expect(calls.at(-1)).toStartWith('https://acme.atlassian.net/rest/api/3/project/search')
  })

  test('a scoped token falls through to the gateway', async () => {
    const calls = stubAtlassian(['https://api.atlassian.com/ex/confluence/cloud-9/wiki/', 'https://api.atlassian.com/ex/jira/cloud-9/rest/'])
    const instance = server()

    await expect(instance.handle('atlassianConnectApiToken', [input], TEST_HANDLER_CTX)).resolves.toEqual({ ok: true })
    await expect(instance.handle('atlassianStatus', [], TEST_HANDLER_CTX)).resolves.toMatchObject({ products: ['jira', 'confluence'] })

    await instance.handle('atlassianJiraProjects', [], TEST_HANDLER_CTX)
    expect(calls.at(-1)).toStartWith('https://api.atlassian.com/ex/jira/cloud-9/rest/api/3/project/search')
  })

  // A token Atlassian refuses must not replace a grant that works.
  test('a refused token answers why and keeps the grant there was', async () => {
    stubAtlassian([])
    records.set('atlassian-oauth', storedGrant)

    await expect(server().handle('atlassianConnectApiToken', [input], TEST_HANDLER_CTX)).resolves.toEqual({
      ok: false,
      error: 'Atlassian did not accept this email and API token for https://acme.atlassian.net.',
    })
    expect(records.get('atlassian-oauth')).toEqual(storedGrant)
  })

  // The token is sent to the address the user typed; plain http would expose it.
  test('refuses a site that is not https before sending the token', async () => {
    const calls = stubAtlassian(['http://acme.example.com/'])
    await expect(server().handle('atlassianConnectApiToken', [{ ...input, siteUrl: 'http://acme.example.com' }], TEST_HANDLER_CTX))
      .resolves.toEqual({ ok: false, error: 'The Atlassian site address must use https.' })
    expect(calls).toEqual([])
  })
})
