import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AtlassianOAuthCompleted, AtlassianStatus } from '@solus/contracts/atlassian'
import type { DocDestination } from '@solus/contracts/docs'

const statuses = new Map<string, AtlassianStatus>()
const destinations = new Map<string, DocDestination[]>()
const destinationReads: string[] = []
let oauthListener: ((serverId: string, event: AtlassianOAuthCompleted) => void) | null = null

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    defaultServerId: () => 'host-a',
    apiFor: (serverId: string) => ({
      atlassianStatus: async () => statuses.get(serverId) ?? {
        connected: false,
        oauthAvailable: true,
      },
      atlassianStartOAuth: async () => ({
        ok: true as const,
        authUrl: `https://auth.atlassian.test/${serverId}`,
        expiresAt: Date.now() + 300_000,
      }),
      docDestinations: async (provider: string) => {
        destinationReads.push(`${serverId}:${provider}`)
        return destinations.get(`${serverId}:${provider}`) ?? []
      },
    }),
  },
}))
mock.module('@solus/client-core/host-events', () => ({
  subscribeAllHosts: (
    _topic: string,
    listener: (serverId: string, event: AtlassianOAuthCompleted) => void,
  ) => {
    oauthListener = listener
    return () => { oauthListener = null }
  },
}))
mock.module('@solus/client-core/local-api', () => ({
  localApi: { openExternal: async () => {} },
}))

Object.assign(globalThis, {
  $state: Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value }),
})

const { AtlassianStore } = await import('@solus/workspace-ui/contexts/atlassian/atlassian.store.svelte')
const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')

beforeEach(() => {
  statuses.clear()
  destinations.clear()
  destinationReads.splice(0)
  oauthListener = null
})

describe('renderer provider ownership', () => {
  test('keeps Atlassian connection and browser-flow state on the owning host', async () => {
    // WHY: a Jira picker on host A must never bind the cloudId delivered by a
    // browser callback from host B.
    statuses.set('host-a', {
      connected: true,
      cloudId: 'cloud-a',
      products: ['jira'],
      oauthAvailable: true,
    })
    statuses.set('host-b', {
      connected: true,
      cloudId: 'cloud-b',
      products: ['jira'],
      oauthAvailable: true,
    })
    const store = new AtlassianStore()
    await Promise.all([store.ensureStatus('host-a'), store.ensureStatus('host-b')])
    await store.startOAuth('host-a')
    store.listenForOAuthCompletion()

    oauthListener?.('host-b', { connected: true })
    await Promise.resolve()

    expect(store.status('host-a')?.cloudId).toBe('cloud-a')
    expect(store.status('host-b')?.cloudId).toBe('cloud-b')
    expect(store.awaitingBrowser('host-a')).toBe(true)
    expect(store.awaitingBrowser('host-b')).toBe(false)
  })

  test('reads current document destinations from the selected host', async () => {
    // WHY: identical keys on two hosts are unrelated, and a folder or space can
    // change while the workspace remains mounted.
    destinations.set('host-a:confluence', [{
      provider: 'confluence', scope: 'ENG', label: 'Host A Engineering',
    }])
    destinations.set('host-b:confluence', [{
      provider: 'confluence', scope: 'ENG', label: 'Host B Engineering',
    }])
    const store = new WorksStore()

    const hostA = await store.loadDocDestinations('confluence', 'host-a')
    const hostB = await store.loadDocDestinations('confluence', 'host-b')
    const hostAAgain = await store.loadDocDestinations('confluence', 'host-a')

    expect(hostA[0]?.label).toBe('Host A Engineering')
    expect(hostB[0]?.label).toBe('Host B Engineering')
    expect(hostAAgain[0]?.label).toBe('Host A Engineering')
    expect(destinationReads).toEqual(['host-a:confluence', 'host-b:confluence', 'host-a:confluence'])
  })
})
