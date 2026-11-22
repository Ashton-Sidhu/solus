import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { HostWebhookSettings, Webhook } from '@solus/contracts/webhooks'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({ serversStore: { servers: [], hostFor: () => null, readinessFor: () => ({ readiness: 'ready' }) } }))
mock.module('@solus/workspace-ui/lib/toasts', () => ({ copyText: async () => {}, toasts: { error: () => {}, info: () => {}, undo: () => {}, success: () => {} } }))
mock.module('@solus/workspace-ui/components/connections/organizations.store.svelte', () => ({ organizationsStore: { statusFor: () => null, refresh: async () => {} } }))

let webhooksStore: typeof import('@solus/workspace-ui/contexts/webhooks/webhooks.store.svelte')['webhooksStore']
beforeAll(async () => {
  ;({ webhooksStore } = await import('@solus/workspace-ui/contexts/webhooks/webhooks.store.svelte'))
})
beforeEach(() => connections.reset())

const settings: HostWebhookSettings = { publicUrl: null, holdWhileOffline: false, linked: false }

function host(webhooks: Webhook[]) {
  const reads: string[] = []
  connections.registerPrimary('mac', {
    webhookList: async () => { reads.push('list'); return webhooks },
    hostWebhookSettingsRead: async () => { reads.push('settings'); return settings },
  })
  return reads
}

describe('webhook host settings', () => {
  // WHY: every host load read the host's webhook settings beside its list,
  // at startup too. Only a settings view and a row's reachability text read
  // them, so a host with no webhooks costs one read.
  test('a host with no webhooks and no settings view reads only its list', async () => {
    const reads = host([])
    await webhooksStore.load('mac')
    expect(reads).toEqual(['list'])
    expect(webhooksStore.hostSettings.get('mac')).toBeUndefined()
  })

  test('a host with webhooks reads its settings for the rows', async () => {
    const reads = host([{ id: 'w1', name: 'Deploy' } as Webhook])
    await webhooksStore.load('mac')
    expect(reads).toEqual(['list', 'settings'])
    expect(webhooksStore.hostSettings.get('mac')).toEqual(settings)
  })
})
