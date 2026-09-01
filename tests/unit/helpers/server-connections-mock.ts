import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import type { HostEventMap, HostEventName } from '@solus/contracts/host-events'
import type { HostCapabilities } from '@solus/contracts/types'
import type { ConnectionStatus } from '@solus/client-core/ws-transport'
import { BrowserFrameSubscriber } from '@solus/client-core/browser-frame-subscriber'

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
  const framesByServerId = new Map<string, BrowserFrameSubscriber>()
  const statusListeners = new Set<(
    serverId: string,
    status: ConnectionStatus,
    attempt: number,
  ) => void>()
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
  const frames = (serverId = primaryServerId) => {
    let subscriber = framesByServerId.get(serverId)
    if (!subscriber) {
      subscriber = new BrowserFrameSubscriber()
      framesByServerId.set(serverId, subscriber)
    }
    return subscriber
  }

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
      for (const subscriber of framesByServerId.values()) subscriber.clear()
      framesByServerId.clear()
      statusListeners.clear()
    },
    resolveId: (serverId: string) => serverId === 'local' ? primaryServerId : serverId,
    ensure: (serverId: string) => connection(serverId),
    apiFor: (serverId: string) => api(serverId),
    setPrimary: (serverId: string) => { primaryServerId = serverId },
    defaultServerId: () => primaryServerId,
    localServerId: () => 'local',
    localHostApi: () => api('local'),
    eventsFor: (serverId: string) => events(serverId),
    framesFor: (serverId: string) => frames(serverId),
    serverIdForApi: (targetApi: HostApi) =>
      [...apis].find(([, candidate]) => candidate === targetApi)?.[0] ?? primaryServerId,
    withTemporaryConnection: async <T>(_serverId: string, operation: (value: HostApi) => Promise<T>) => operation(api()),
    connectedServerIds: () => apis.size > 0 ? [...apis.keys()] : [primaryServerId],
    connectionFor: (serverId?: string) => connection(serverId),
    updateStatus: () => {},
    onStatusChange: (listener: (
      serverId: string,
      status: ConnectionStatus,
      attempt: number,
    ) => void) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    emitStatus: (serverId: string, status: ConnectionStatus, attempt = 0) => {
      for (const listener of statusListeners) listener(serverId, status, attempt)
    },
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
