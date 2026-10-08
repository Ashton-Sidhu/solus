import { describe, expect, mock, test } from 'bun:test'
import type { Integration, IntegrationToolSummary } from '@solus/contracts/integration-types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { integrationsStore: store } = await import('@solus/workspace-ui/components/settings/integrations.store.svelte')

const integration = (id: string, name = id): Integration => ({
  id, organizationId: 'local', kind: 'mcp', slug: id, name, url: `https://${id}.example/mcp`,
  auth: { kind: 'none' }, createdBy: null, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z',
})
const tool = (name: string): IntegrationToolSummary => ({ name, description: '', readOnly: false, destructive: false })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('integrations store', () => {
  test('another client\'s changes reach the list without a reload', async () => {
    const records = new Map([['wiki', integration('wiki')]])
    connections.registerHost('events', {
      integrationList: async () => [...records.values()],
      integrationGet: async ({ id }: { id: string }) => records.get(id) ?? null,
    })
    const stop = store.watch('events')
    await flush()
    records.set('linear', integration('linear'))
    connections.emit('events', 'integration.changed', { integrationId: 'linear', change: 'created' })
    await flush()
    expect(store.states.get('events')?.integrations?.map((item) => item.id)).toEqual(['wiki', 'linear'])
    records.set('wiki', integration('wiki', 'DeepWiki'))
    connections.emit('events', 'integration.changed', { integrationId: 'wiki', change: 'updated' })
    await flush()
    expect(store.states.get('events')?.integrations?.[0]?.name).toBe('DeepWiki')
    connections.emit('events', 'integration.changed', { integrationId: 'linear', change: 'removed' })
    expect(store.states.get('events')?.integrations?.map((item) => item.id)).toEqual(['wiki'])
    expect(store.names()).toContain('DeepWiki')
    stop()
  })

  test('a tools change reloads only tools that were loaded', async () => {
    let calls = 0
    connections.registerHost('tools', {
      integrationList: async () => [integration('wiki'), integration('other')],
      integrationTools: async () => { calls++; return [tool(`t${calls}`)] },
    })
    const stop = store.watch('tools')
    await flush()
    await store.loadTools('tools', 'wiki')
    connections.emit('tools', 'integration.changed', { integrationId: 'wiki', change: 'tools' })
    connections.emit('tools', 'integration.changed', { integrationId: 'other', change: 'tools' })
    await flush()
    expect(calls).toBe(2)
    expect(store.states.get('tools')?.tools.get('wiki')).toEqual([tool('t2')])
    expect(store.states.get('tools')?.tools.has('other')).toBe(false)
    stop()
  })

  test('an older host without integrations reads as unsupported, not as an error', async () => {
    connections.registerHost('old', { integrationList: async () => { throw new Error('SolusServer: no handler for "integrationList"') } })
    await store.load('old')
    expect(store.states.get('old')?.isUnsupported).toBe(true)
    expect(store.states.get('old')?.error).toBe('')
  })

  test('disconnect drops an in-flight list; reconnect reloads it', async () => {
    let answer!: (value: Integration[]) => void
    connections.registerHost('reconnect', { integrationList: () => new Promise<Integration[]>((resolve) => { answer = resolve }) })
    const stop = store.watch('reconnect')
    connections.emitStatus('reconnect', 'reconnecting')
    answer([integration('stale')])
    await flush()
    expect(store.states.get('reconnect')?.isDisconnected).toBe(true)
    expect(store.states.get('reconnect')?.integrations).toBeNull()
    connections.emitStatus('reconnect', 'connected')
    answer([integration('fresh')])
    await flush()
    expect(store.states.get('reconnect')?.integrations?.map((item) => item.id)).toEqual(['fresh'])
    expect(store.states.get('reconnect')?.isDisconnected).toBe(false)
    stop()
  })

  test('a failed create keeps the list and reports why', async () => {
    connections.registerHost('write', {
      integrationList: async () => [],
      integrationCreate: async () => { throw new Error('Only a host administrator can add integrations.') },
    })
    await store.load('write')
    expect(await store.create('write', { name: 'Wiki', url: 'https://wiki.example/mcp' })).toBeNull()
    expect(store.states.get('write')?.integrations).toEqual([])
    expect(store.states.get('write')?.writeError).toBe('Only a host administrator can add integrations.')
    expect(store.states.get('write')?.saving).toBe(false)
  })
})
