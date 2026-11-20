import { createSubscriber } from 'svelte/reactivity'
import { RunningServers } from '@solus/client-core/running-servers'
import { serverConnections } from '@solus/client-core/server-connections'
import { localApi } from '@solus/client-core/local-api'
import type { RunningServer, ServerEndpoint } from '@solus/contracts/running-servers'

/** Reading a host's list retains one shared subscription until its last
 *  reactive reader leaves. Components own no loading or reconnect logic. */
export class RunningServersStore {
  readonly #core: RunningServers
  readonly #subscribe: () => void

  constructor(hostId: string) {
    this.#core = new RunningServers(() => ({
      api: serverConnections.apiFor(hostId),
      events: serverConnections.eventsFor(hostId),
      ready: serverConnections.readinessFor(hostId).readiness === 'ready',
    }), (changed) => {
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

  get status() { this.#subscribe(); return this.#core.current.status }
  get servers() { this.#subscribe(); return this.#core.current.servers }
  get error() { this.#subscribe(); return this.#core.current.error }
  get forwarded() { this.#subscribe(); return this.#core.forwarded }
  get canForward() { return this.#core.canForward }
  inCheckout(path: string | null) { this.#subscribe(); return this.#core.inCheckout(path) }
  // The narrower interface owns the reactive retention and hides connection details.
  stop(serverId: string) { return this.#core.stop(serverId) }
  retry() { this.#core.retry() }
  retainCheckout(path: string | null) { return this.#core.retainCheckout(path) }
  configuredUrls(path: string) { return this.#core.configuredUrls(path) }
  configureUrls(path: string, urls: string[]) { return this.#core.configureUrls(path, urls) }
  forward(server: RunningServer, endpoint: ServerEndpoint) { return this.#core.forward(server, endpoint) }
  stopForward(forwardId: string) { return this.#core.stopForward(forwardId) }
  openExternal(server: RunningServer, endpoint: ServerEndpoint) { return this.#core.openExternal(server, endpoint) }
}
