import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import type { SecretStore } from '@solus/server/platform/secrets'

/**
 * A build that ships no Atlassian OAuth client — an open-source or local build
 * without the release secrets. It must fall back to the API token rather than
 * opening a browser flow that cannot possibly complete.
 *
 * Separate file because bun's module mocks are process-wide: the sibling
 * atlassian-oauth.test.ts mocks these same constants to present values.
 */

const records = new Map<string, unknown>()
const store: SecretStore = {
  // SAFETY: nothing writes to this store in this file; loads return null.
  loadJson: <T>(key: string) => (records.get(key) as T | undefined) ?? null,
  saveJson: (key: string, _path: string, value: unknown) => { records.set(key, value) },
  remove: (key: string) => { records.delete(key) },
  canSave: () => true,
}

mock.module('@solus/server/platform/secrets', () => ({ secretStore: () => store }))
mock.module('@solus/server/atlassian/client-id', () => ({ ATLASSIAN_CLIENT_ID: '' }))
mock.module('@solus/server/atlassian/client-secret', () => ({ ATLASSIAN_CLIENT_SECRET: '' }))

let oauth: typeof import('@solus/server/atlassian/oauth')
let registerAtlassianHandlers: typeof import('@solus/server/server/handlers/atlassian-handlers')['registerAtlassianHandlers']
let SolusServer: typeof import('@solus/server/server/server')['SolusServer']

beforeAll(async () => {
  oauth = await import('@solus/server/atlassian/oauth')
  ;({ SolusServer } = await import('@solus/server/server/server'))
  ;({ registerAtlassianHandlers } = await import('@solus/server/server/handlers/atlassian-handlers'))
})

describe('Atlassian OAuth on a build with no client credentials', () => {
  test('does not advertise the browser flow', () => {
    expect(oauth.isOAuthConfigured()).toBe(false)
  })

  // It must also refuse before binding the callback port, so an unconfigured
  // build never holds a port it can do nothing with.
  test('refuses before building an authorize URL that cannot be redeemed', async () => {
    await expect(oauth.startOAuthFlow()).rejects.toThrow(oauth.AtlassianOAuthUnconfiguredError)
  })

  // The renderer reads `ok: false` to keep the browser button hidden and leave
  // the token form as the only way in.
  test('the handler reports the refusal instead of raising', async () => {
    const server = new SolusServer()
    registerAtlassianHandlers(server)

    const result = await server.handle('atlassianStartOAuth', [], TEST_HANDLER_CTX)
    expect(result).toMatchObject({ ok: false })
    // The status is what the UI reads to replace the button with an
    // explanation, so it must say the build cannot sign in at all.
    expect(await server.handle('atlassianStatus', [], TEST_HANDLER_CTX)).toEqual({
      connected: false,
      oauthAvailable: false,
    })
  })
})
