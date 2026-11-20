import { createSubscriber } from 'svelte/reactivity'
import { RunningServersStore as CoreStore } from '@solus/client-core/running-servers'
import { serverConnections } from '@solus/client-core/server-connections'
import { localApi } from '@solus/client-core/local-api'
import { SvelteMap } from 'svelte/reactivity'
import { untrack } from 'svelte'

/** Reading a host's list retains one shared subscription until its last
 *  reactive reader leaves. Components own no loading or reconnect logic. */
export class RunningServersStore {
  readonly #core: CoreStore
  readonly #subscribe: () => void

  constructor(hostId: string) {
    this.#core = new CoreStore(() => {
      if (serverConnections.readinessFor(hostId).readiness !== 'ready') return null
      return { api: serverConnections.apiFor(hostId), events: serverConnections.eventsFor(hostId), ready: true }
    }, (changed) => {
      const stops = [serverConnections.onReadinessChange(changed), serverConnections.onConnectionCreated(changed)]
      return () => { for (const stop of stops) stop() }
    }, ['darwin', 'linux', 'win32'].includes(localApi.getPlatform?.() ?? 'web') ? {
      keyPrefix: hostId,
      origin: () => serverConnections.httpOriginFor(hostId),
      start: (request) => localApi.serverForwardStart(request),
      stop: (forwardId) => localApi.serverForwardStop(forwardId),
      list: () => localApi.serverForwardList(),
      openExternal: (url) => localApi.openExternal(url),
    } : undefined)
    this.#subscribe = createSubscriber((update) => {
      const stop = this.#core.subscribe(update)
      const release = this.#core.retain()
      return () => { stop(); release() }
    })
  }

  get status() { this.#subscribe(); return this.#core.status }
  get servers() { this.#subscribe(); return this.#core.servers }
  get error() { this.#subscribe(); return this.#core.error }
  inCheckout(path: string | null) { this.#subscribe(); return this.#core.inCheckout(path) }
  rows(path?: string | null) { this.#subscribe(); return this.#core.rows(path) }
  retry() { this.#core.retry() }
  retainCheckout(path: string | null) { return this.#core.retainCheckout(path) }
  configuredUrls(path: string) { return this.#core.configuredUrls(path) }
  configureUrls(path: string, urls: string[]) { return this.#core.configureUrls(path, urls) }
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
