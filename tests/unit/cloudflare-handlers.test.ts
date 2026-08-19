import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { SecretStore } from '@solus/server/platform/secrets'

const records = new Map<string, unknown>()
const store: SecretStore = {
  loadJson: <T>(key: string) => (records.get(key) as T | undefined) ?? null,
  saveJson: (key: string, _path: string, value: unknown) => { records.set(key, value) },
  remove: (key: string) => { records.delete(key) },
  canSave: () => true,
}
const originalFetch = globalThis.fetch
const originalApiToken = process.env.CLOUDFLARE_API_TOKEN
const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID

mock.module('@solus/server/platform/secrets', () => ({ secretStore: () => store }))

let SolusServer: typeof import('@solus/server/server/server')['SolusServer']
let registerCloudflareHandlers: typeof import('@solus/server/server/handlers/cloudflare-handlers')['registerCloudflareHandlers']

beforeAll(async () => {
  ;({ SolusServer } = await import('@solus/server/server/server'))
  ;({ registerCloudflareHandlers } = await import('@solus/server/server/handlers/cloudflare-handlers'))
})

beforeEach(() => {
  records.clear()
  delete process.env.CLOUDFLARE_API_TOKEN
  delete process.env.CLOUDFLARE_ACCOUNT_ID
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalApiToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN
  else process.env.CLOUDFLARE_API_TOKEN = originalApiToken
  if (originalAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID
  else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId
})

function server(): InstanceType<typeof SolusServer> {
  const instance = new SolusServer()
  registerCloudflareHandlers(instance)
  return instance
}

describe('Cloudflare RPC handlers', () => {
  test('reports disconnected for a clean profile', async () => {
    await expect(server().handle('cloudflareStatus', [])).resolves.toEqual({ connected: false })
  })

  test('does not persist an invalid token', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: false }), { status: 401 })) as typeof fetch
    await expect(server().handle('cloudflareConnect', [{ apiToken: 'invalid' }])).resolves.toMatchObject({
      ok: false,
      kind: 'invalid',
    })
    expect(records.size).toBe(0)
  })

  test('uses environment credentials without reading stored credentials', async () => {
    records.set('cloudflare-api-token', { apiToken: 'stored', accountId: 'stored-account' })
    process.env.CLOUDFLARE_API_TOKEN = 'environment-token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'environment-account'
    await expect(server().handle('cloudflareStatus', [])).resolves.toEqual({
      connected: true,
      source: 'env',
      accountId: 'environment-account',
    })
  })
})
