import { expect, test } from 'bun:test'
import type { Integration } from '@solus/contracts/integration-types'
import type { ConnectionProvider } from '@solus/contracts/connections'
import { AppIntegrationCalls } from '@solus/server/apps/app-integrations'
import { hostConnections } from '@solus/server/apps/app-connections'
import type { StoredValue } from '@solus/server/apps/app-storage'
import type { AppRecord, AppVersionRecord } from '@solus/server/data/apps/app-store'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'

const linear: Pick<Integration, 'id' | 'name' | 'slug' | 'disabledTools'> = { id: 'int-linear', name: 'Linear', slug: 'linear', disabledTools: [] }
// SAFETY: the integration calls read only the owner and organization of an app and the roles of a version.
const app = { id: 'app-1', ownerKey: 'owner', organizationId: 'local' } as AppRecord
const version = (integrations: string[], appIntegrations: string[] = []) => ({ descriptor: { solusApp: 4, integrations, appIntegrations } }) as AppVersionRecord

function setup(mcpSlugs: string[] = []) {
  const requests: { provider: ConnectionProvider; input: StoredValue; person: string | null }[] = []
  let person: string | null = 'caller'
  const calls = new AppIntegrationCalls({
    gateway: {
      callAppTool: async () => ({ content: [{ type: 'text', text: '"from mcp"' }] }),
      toolsFor: async () => [],
      connectionStatus: async () => ({ status: 'connected', label: null, signInRequired: false }),
    },
    // SAFETY: the integration calls read only these four fields of an integration.
    integrations: { getBySlug: (slug) => (mcpSlugs.includes(slug) ? { ...linear, slug } as Integration : null) },
    connections: {
      connected: async (provider) => provider === 'github',
      request: async (provider, input) => {
        requests.push({ provider, input, person })
        return { from: provider }
      },
    },
    runAs: (personKey, run) => {
      const before = person
      person = personKey
      try { return run() } finally { person = before }
    },
  })
  return { calls, requests }
}

test('a role with no MCP integration of that slug reaches the built-in connection, as the caller', async () => {
  // WHY: an app uses the person's own GitHub, Atlassian, or Google sign-in, and never holds the token.
  const { calls, requests } = setup()
  expect(await calls.call(app, version(['github']), 'github', 'request', { path: '/user' }, TEST_HANDLER_CTX)).toEqual({ from: 'github' })
  expect(requests).toEqual([{ provider: 'github', input: { path: '/user' }, person: 'caller' }])
})

test('the host\'s own work reaches a built-in connection as the app owner', async () => {
  // WHY: a schedule, a webhook, or a workflow has no person in its call (docs/plans/apps.md §5).
  const { calls, requests } = setup()
  await calls.call(app, version(['atlassian'], ['atlassian']), 'atlassian', 'request', { product: 'jira', path: '/rest/api/3/myself' }, null)
  expect(requests[0]?.person).toBe('owner')
})

test('the person\'s MCP integration with the same slug comes before the built-in connection', async () => {
  // WHY: an app that already uses an MCP server named github keeps its behaviour.
  const { calls, requests } = setup(['github'])
  expect(await calls.call(app, version(['github']), 'github', 'list_pulls', {}, TEST_HANDLER_CTX)).toBe('from mcp')
  expect(requests).toEqual([])
})

test('a built-in connection has one tool, and only for an app that names it', async () => {
  const { calls } = setup()
  await expect(calls.call(app, version(['google']), 'google', 'list_files', {}, TEST_HANDLER_CTX)).rejects.toThrow('Google Drive has one tool for an app: request.')
  await expect(calls.call(app, version([]), 'github', 'request', { path: '/user' }, TEST_HANDLER_CTX)).rejects.toThrow('This app does not name the integration github.')
})

test('a built-in role reads as the connection, with whether the reader is connected', async () => {
  const { calls } = setup(['linear'])
  expect(await calls.roles(app, version(['linear', 'github', 'atlassian', 'notion']).descriptor, TEST_HANDLER_CTX)).toEqual([
    { slug: 'linear', scope: 'user', name: 'Linear', connected: true },
    { slug: 'github', scope: 'user', name: 'GitHub', connected: true },
    { slug: 'atlassian', scope: 'user', name: 'Atlassian', connected: false },
    { slug: 'notion', scope: 'user', name: null, connected: false },
  ])
})

test('a request path cannot name another host, so the credential stays with its provider', async () => {
  // WHY: the host adds the person's token; a full URL would send it to whoever the app names.
  for (const path of ['https://evil.example/x', '//evil.example/x', 'repos/acme/web']) {
    await expect(hostConnections.request('github', { path })).rejects.toThrow('A path starts with one /')
    await expect(hostConnections.request('google', { path })).rejects.toThrow('A path starts with one /')
    await expect(hostConnections.request('atlassian', { product: 'jira', path })).rejects.toThrow('A path starts with one /')
  }
})
