import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import type { HostEventMap, HostEventName } from '@solus/contracts/host-events'
import type { HostCapabilities } from '@solus/contracts/types'

const capabilities: HostCapabilities = {
  attachUpload: true,
  assetUrls: true,
  skillsInstall: true,
  skillsSearch: true,
  voiceModel: true,
  automations: true,
  editors: ['vscode', 'vim', 'nvim', 'helix'],
  githubProvider: true,
}

function currentApi(): HostApi {
  const api = (globalThis as unknown as { window: { solus: object } }).window.solus
  return asHostApi(api)
}

/**
 * Complete single-host registry used by renderer tests that mock the connection
 * module. Keeping the public surface complete prevents one file's Bun module
 * mock from removing host-routing methods from later test files.
 */
export function singleHostServerConnections() {
  let primaryServerId = 'local'
  const apis = new Map<string, HostApi>()
  const eventsByServerId = new Map<string, HostEventSubscriber>()
  const api = (serverId = primaryServerId) => apis.get(serverId) ?? currentApi()
  const events = (serverId = primaryServerId) => {
    let subscriber = eventsByServerId.get(serverId)
    if (!subscriber) {
      subscriber = new HostEventSubscriber()
      eventsByServerId.set(serverId, subscriber)
    }
    return subscriber
  }
  const connection = (serverId = primaryServerId) => ({
    serverId,
    target: { id: serverId, label: serverId, url: 'http://test.invalid', sessionToken: 'test', local: serverId === 'local' },
    transport: { destroy: () => {}, events: events(serverId) },
    api: api(serverId),
    events: events(serverId),
    status: 'connected' as const,
    attempt: 0,
  })

  return {
    registerTarget: () => {},
    registerPrimary: (serverId: string, nextApi: object) => {
      primaryServerId = serverId
      apis.set(serverId, asHostApi(nextApi))
      return connection(serverId)
    },
    registerHost: (serverId: string, nextApi: object) => {
      apis.set(serverId, asHostApi(nextApi))
      return connection(serverId)
    },
    reset: () => {
      primaryServerId = 'local'
      apis.clear()
      for (const subscriber of eventsByServerId.values()) subscriber.clear()
      eventsByServerId.clear()
    },
    resolveId: (serverId: string) => serverId === 'local' ? primaryServerId : serverId,
    ensure: (serverId: string) => connection(serverId),
    apiFor: (serverId: string) => api(serverId),
    setPrimary: (serverId: string) => { primaryServerId = serverId },
    defaultServerId: () => primaryServerId,
    localServerId: () => 'local',
    localHostApi: () => api('local'),
    eventsFor: (serverId: string) => events(serverId),
    eventsForApi: (targetApi: HostApi) => events(
      [...apis].find(([, candidate]) => candidate === targetApi)?.[0] ?? primaryServerId,
    ),
    serverIdForApi: (targetApi: HostApi) =>
      [...apis].find(([, candidate]) => candidate === targetApi)?.[0] ?? primaryServerId,
    withTemporaryConnection: async <T>(_serverId: string, operation: (value: HostApi) => Promise<T>) => operation(api()),
    connectedServerIds: () => apis.size > 0 ? [...apis.keys()] : [primaryServerId],
    connectionFor: (serverId?: string) => connection(serverId),
    updateStatus: () => {},
    onStatusChange: () => () => {},
    onConnectionCreated: () => () => {},
    onPhaseChange: () => () => {},
    phaseFor: () => 'connected' as const,
    dialNow: () => {},
    startCatalogSupervisors: () => {},
    retain: () => {},
    unretain: () => {},
    release: () => {},
    statusFor: () => 'connected' as const,
    probeHealth: async () => null,
    capabilitiesFor: async () => capabilities,
    capability: (_serverId: string, key: Exclude<keyof HostCapabilities, 'editors'>) => capabilities[key] === true,
    cachedCapabilitiesFor: () => capabilities,
    verifySavedServerIdentity: async () => true,
    projectIdentities: async () => [],
    emit: <K extends HostEventName>(serverId: string, type: K, payload: HostEventMap[K]) => {
      events(serverId).receive({ type, payload, occurredAt: Date.now() })
    },
  }
}
