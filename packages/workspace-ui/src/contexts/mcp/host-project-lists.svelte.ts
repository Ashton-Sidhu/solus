import { SvelteMap } from 'svelte/reactivity'
import { HostProjectLists as Lists, type HostListsSource, type HostProjectListsOptions } from '@solus/client-core/host-project-lists'
import { hostCatalog } from '@solus/client-core/host-catalog'
import { serverConnections } from '@solus/client-core/server-connections'

const source: HostListsSource = {
  connection: (serverId) => ({ api: serverConnections.apiFor(serverId), events: serverConnections.eventsFor(serverId) }),
  watchReconnects: (serverId, reconnected) => serverConnections.onReadinessChange((hostId, readiness) => {
    if (hostId === serverId && readiness === 'ready') reconnected()
  }),
  onForgotten: (forgotten) => hostCatalog.onForgotten((host) => forgotten(host.id)),
}

/**
 * The client-core `HostProjectLists` on this client's hosts, kept in
 * `SvelteMap`s so a menu that reads one list wakes for that list only.
 */
export class HostProjectLists<T> extends Lists<T> {
  constructor(options: HostProjectListsOptions<T>) {
    super({ ...options, source, map: () => new SvelteMap() })
  }
}
