import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { InboxUpstreamResult } from '@solus/contracts/inbox-types'

let calls = 0
let response: () => Promise<InboxUpstreamResult>
let serverIds = ['host-1']
const phases = new Map<string, string>()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    connectedServerIds: () => serverIds,
    phaseFor: (serverId: string) => phases.get(serverId) ?? 'connected',
    apiFor: () => ({
      inboxListUpstream: () => {
        calls += 1
        return response()
      },
    }),
  },
}))

Object.assign(globalThis, {
  $state: Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value }),
  $derived: <T>(value: T) => value,
})

const { InboxStore } = await import('@solus/workspace-ui/contexts/tasks/inbox.store.svelte')

beforeEach(() => {
  calls = 0
  serverIds = ['host-1']
  phases.clear()
  response = () => Promise.resolve({ scopes: [] })
})

describe('task inbox loading lifecycle', () => {
  test('one explicit load makes one request and settles the loading state', async () => {
    // WHY: page entry is one refresh boundary. A completed snapshot must not
    // recursively become another request and leave the skeleton on screen.
    const store = new InboxStore()
    await store.load()

    expect(calls).toBe(1)
    expect(store.loading).toBe(false)
  })

  test('a failed host read retains its prior snapshot and stops loading', async () => {
    const store = new InboxStore()
    store.scopes = [{
      serverId: 'host-1',
      provider: 'github',
      externalKey: 'solus/solus',
      projects: [{ projectKey: '/repo', projectLabel: 'repo' }],
      tickets: [],
      pullRequests: [],
    }]
    response = () => Promise.reject(new Error('offline'))

    await store.load()

    expect(store.loading).toBe(false)
    expect(store.scopes).toHaveLength(1)
    expect(store.scopes[0].fromCache).toBe(true)
    expect(store.hostErrors.get('host-1')).toBe('offline')
  })

  test('a reconnecting host retains its prior snapshot as stale', async () => {
    const store = new InboxStore()
    store.scopes = [{
      serverId: 'host-1',
      provider: 'github',
      externalKey: 'solus/solus',
      projects: [{ projectKey: '/repo', projectLabel: 'repo' }],
      tickets: [],
      pullRequests: [],
    }]
    phases.set('host-1', 'reconnecting')

    await store.load()

    expect(calls).toBe(0)
    expect(store.scopes).toHaveLength(1)
    expect(store.scopes[0].fromCache).toBe(true)
    expect(store.hostErrors.get('host-1')).toBe('Host is reconnecting.')
  })
})
