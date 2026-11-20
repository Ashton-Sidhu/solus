import { RunningServers, RunningServersController, type RunningServersStoreState } from '@solus/client-core/running-servers'
import { serverConnections } from '@solus/client-core/server-connections'
import { localApi } from '@solus/client-core/local-api'
import { SvelteMap } from 'svelte/reactivity'
import { untrack } from 'svelte'

/** Rune-backed state for one host. Surfaces explicitly retain its discovery lease. */
export class RunningServersStore {
  status = $state<RunningServersStoreState['status']>('loading')
  error = $state<string | null>(null)
  servers = $state.raw<readonly RunningServers[]>([])
  revision = $state(0)
  readonly #controller: RunningServersController

  constructor(hostId: string, connections: Pick<typeof serverConnections, 'readinessFor' | 'apiFor' | 'eventsFor' | 'onReadinessChange' | 'onConnectionCreated' | 'httpOriginFor'> = serverConnections) {
    this.#controller = new RunningServersController(() => {
      if (connections.readinessFor(hostId).readiness !== 'ready') return null
      return { api: connections.apiFor(hostId), events: connections.eventsFor(hostId), ready: true }
    }, (changed) => {
      const stops = [connections.onReadinessChange(changed), connections.onConnectionCreated(changed)]
      return () => { for (const stop of stops) stop() }
    }, ['darwin', 'linux', 'win32'].includes(localApi.getPlatform?.() ?? 'web') ? {
      keyPrefix: hostId,
      origin: () => connections.httpOriginFor(hostId),
      start: (request) => localApi.serverForwardStart(request),
      stop: (forwardId) => localApi.serverForwardStop(forwardId),
      list: () => localApi.serverForwardList(),
      openExternal: (url) => localApi.openExternal(url),
    } : undefined, {
      state: this,
      createServer: (data, commands) => {
        const state = $state({ data, revision: 0 })
        return new RunningServers(data, commands, state)
      },
    })
  }

  inCheckout(path: string | null) { return this.#controller.inCheckout(path) }
  rows(path?: string | null) { return this.#controller.rows(path) }
  retry() { this.#controller.retry() }
  retainCheckout(path: string | null) { return this.#controller.retainCheckout(path) }
  configuredUrls(path: string) { return this.#controller.configuredUrls(path) }
  configureUrls(path: string, urls: string[]) { return this.#controller.configureUrls(path, urls) }
}


/** The feature owns its reactive registry. Hosts and the application own no server collections. */
class RunningServersRegistry {
  readonly #stores = new SvelteMap<string, RunningServersStore>()
  get stores(): readonly RunningServersStore[] { return [...this.#stores.values()] }
  forHost(hostId: string): RunningServersStore {
    return untrack(() => {
      const serverId = serverConnections.factsFor(hostId).serverId
      let store = this.#stores.get(serverId)
      if (!store) { store = new RunningServersStore(serverId); this.#stores.set(serverId, store) }
      return store
    })
  }
}
export const runningServers = new RunningServersRegistry()
