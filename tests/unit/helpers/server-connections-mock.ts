import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import type { HostEventMap, HostEventName } from '@solus/contracts/host-events'
import type { HostCapabilities } from '@solus/contracts/types'
import type { HostReadinessState, LinkReadiness } from '@solus/client-core/host-readiness'
import { BrowserFrameSubscriber } from '@solus/client-core/browser-frame-subscriber'
import { HostFacts } from '@solus/client-core/host-facts'

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
  const factsByServerId = new Map<string, HostFacts>()
  const readinessListeners = new Set<(serverId: string, readiness: LinkReadiness, attempt: number) => void>()
  const readinessByServerId = new Map<string, LinkReadiness>()
  const api = (serverId = primaryServerId) => apis.get(serverId) ?? currentApi()
  const events = (serverId = primaryServerId) => {
    let subscriber = eventsByServerId.get(serverId)
    if (!subscriber) {
      subscriber = new HostEventSubscriber()
      eventsByServerId.set(serverId, subscriber)
    }
    return subscriber
  }
  // Each host's facts start with the test capabilities, as if the host had answered.
  const facts = (serverId = primaryServerId) => {
    let hostFacts = factsByServerId.get(serverId)
    if (!hostFacts) {
      hostFacts = new HostFacts(serverId, { api: api(serverId), events: events(serverId) })
      hostFacts.set('capabilities', capabilities)
      factsByServerId.set(serverId, hostFacts)
    }
    return hostFacts
  }
  const connection = (serverId = primaryServerId) => ({
    serverId,
    target: { id: serverId, label: serverId, url: 'http://test.invalid', sessionToken: 'test', local: serverId === 'local' },
    transport: { destroy: () => {}, events: events(serverId) },
    api: api(serverId),
    events: events(serverId),
    link: { readiness: readinessByServerId.get(serverId) ?? 'ready', attempt: 0 },
    facts: facts(serverId),
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
    serverInfoFor: (serverId: string) => api(serverId).connectionsGetServerInfo(),
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
      for (const hostFacts of factsByServerId.values()) hostFacts.dispose()
      factsByServerId.clear()
      readinessListeners.clear()
      readinessByServerId.clear()
    },
    resolveId: (serverId: string) => serverId === 'local' ? primaryServerId : serverId,
    ensure: (serverId: string) => connection(serverId),
    apiFor: (serverId: string) => api(serverId),
    setPrimary: (serverId: string) => { primaryServerId = serverId },
    defaultServerId: () => primaryServerId,
    // Every host in a single-host test is a machine this client knows.
    runOnHostId: () => primaryServerId,
    presenceOf: () => 'present' as const,
    localServerId: () => 'local',
    localHostApi: () => api('local'),
    factsFor: (serverId: string) => facts(serverId),
    eventsFor: (serverId: string) => events(serverId),
    framesFor: (serverId: string) => frames(serverId),
    serverIdForApi: (targetApi: HostApi) =>
      [...apis].find(([, candidate]) => candidate === targetApi)?.[0] ?? primaryServerId,
    withTemporaryConnection: async <T>(_serverId: string, operation: (value: HostApi) => Promise<T>) => operation(api()),
    connectedServerIds: () => apis.size > 0 ? [...apis.keys()] : [primaryServerId],
    connectionFor: (serverId?: string) => connection(serverId),
    httpOriginFor: (serverId: string) => new URL(connection(serverId).target.url).origin,
    onConnectionCreated: () => () => {},
    onDialOutcome: () => () => {},
    onPrimaryChange: () => () => {},
    onReadinessChange: (listener: (serverId: string, readiness: LinkReadiness, attempt: number) => void) => {
      readinessListeners.add(listener)
      return () => readinessListeners.delete(listener)
    },
    readinessFor: (serverId: string): HostReadinessState => {
      const readiness = readinessByServerId.get(serverId) ?? 'ready'
      return {
        readiness,
        away: readiness === 'unreachable' || readiness === 'refused',
        unreachableReason: readiness === 'unreachable' ? 'no-answer' : null,
        refusedReason: readiness === 'refused' ? 'auth' : null,
        lastSeenAt: null,
      }
    },
    /** Move one host's readiness, as a drop or a reconnect does. */
    emitReadiness: (serverId: string, readiness: LinkReadiness) => {
      readinessByServerId.set(serverId, readiness)
      for (const listener of readinessListeners) listener(serverId, readiness, 0)
    },
    dialNow: () => {},
    startCatalogSupervisors: () => {},
    retain: () => {},
    unretain: () => {},
    release: () => {},
    probeHealth: async () => null,
    capabilitiesFor: async () => capabilities,
    cachedCapabilitiesFor: () => capabilities,
    verifySavedServerIdentity: async () => true,
    projectIdentities: async () => [],
    emit: <K extends HostEventName>(serverId: string, type: K, payload: HostEventMap[K]) => {
      events(serverId).receive({ type, payload, occurredAt: Date.now() })
    },
  }
}
