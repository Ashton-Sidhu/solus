import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
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

let SolusServer: typeof import('@solus/server/server/server')['SolusServer']
let registerAtlassianHandlers: typeof import('@solus/server/server/handlers/atlassian-handlers')['registerAtlassianHandlers']
beforeAll(async () => {
  ;({ SolusServer } = await import('@solus/server/server/server'))
  ;({ registerAtlassianHandlers } = await import('@solus/server/server/handlers/atlassian-handlers'))
})

beforeEach(() => {
  records.clear()
})

function server(): InstanceType<typeof SolusServer> {
  const instance = new SolusServer()
  registerAtlassianHandlers(instance, {
    cancelOAuthFlow: () => {},
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
    await expect(server().handle('atlassianStatus', [])).resolves.toEqual({
      connected: false,
      oauthAvailable: true,
    })
  })

  test('reports the site a stored grant reaches', async () => {
    records.set('atlassian-oauth', storedGrant)
    await expect(server().handle('atlassianStatus', [])).resolves.toEqual({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      cloudId: 'cloud-1',
      siteName: 'Acme',
      products: ['jira', 'confluence'],
      oauthAvailable: true,
    })
  })

  // The status is the renderer's only view of the connection, and no credential
  // material may reach it — the browser flow keeps tokens on the host.
  test('never puts token material in the status', async () => {
    records.set('atlassian-oauth', storedGrant)
    const status = JSON.stringify(await server().handle('atlassianStatus', []))
    expect(status).not.toContain('access-1')
    expect(status).not.toContain('refresh-1')
  })

  test('starting a sign-in yields an Atlassian authorize URL', async () => {
    await expect(server().handle('atlassianStartOAuth', [])).resolves.toMatchObject({
      ok: true,
      authUrl: expect.stringContaining('https://auth.atlassian.com/authorize?'),
    })
  })

  // Disconnect drops Solus's copy only; revoking at Atlassian is the user's to
  // do. It must also release the port, or an abandoned sign-in blocks the next.
  test('disconnect clears the stored grant', async () => {
    records.set('atlassian-oauth', storedGrant)
    const instance = server()
    await instance.handle('atlassianDisconnect', [])

    expect(records.size).toBe(0)
    await expect(instance.handle('atlassianStatus', [])).resolves.toMatchObject({ connected: false })
  })

  test('cancelling frees the callback port for the next attempt', async () => {
    const instance = server()
    await instance.handle('atlassianStartOAuth', [])
    await instance.handle('atlassianCancelOAuth', [])
    await expect(instance.handle('atlassianStartOAuth', [])).resolves.toMatchObject({ ok: true })
  })
})
