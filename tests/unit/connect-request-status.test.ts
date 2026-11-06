import { expect, mock, test } from 'bun:test'

/**
 * A server that needs no sign-in has no connection record. Its row must read
 * Connected, or the person who just added it is asked to connect to nothing.
 */

const integrations = [
  { id: 'open', auth: { kind: 'none' } },
  { id: 'keyed', auth: { kind: 'bearer', scheme: 'bearer' } },
]

mock.module('@solus/workspace-ui/components/settings/integrations.store.svelte', () => ({
  integrationsStore: { states: new Map([['studio', { integrations }]]), connection: () => null },
}))
mock.module('@solus/workspace-ui/contexts', () => ({ connectionsStore: {} }))
mock.module('@solus/workspace-ui/contexts/atlassian/atlassian.store.svelte', () => ({ atlassianStore: {} }))

const request = (integrationId: string) => ({ kind: 'integration' as const, serverId: 'studio', sessionId: 's', integrationId, integrationName: integrationId })

test('a server with no sign-in is connected, and one that needs a key is not', async () => {
  const { connectRequestStatus } = await import('@solus/workspace-ui/components/connections/lib/connect-request-status')
  expect(connectRequestStatus(request('open'))).toBe('connected')
  expect(connectRequestStatus(request('keyed'))).toBe('pending')
})

test('a custom server waits for its address', async () => {
  const { connectRequestStatus } = await import('@solus/workspace-ui/components/connections/lib/connect-request-status')
  expect(connectRequestStatus({ kind: 'custom-server', serverId: 'studio', sessionId: 's' })).toBe('pending')
})
