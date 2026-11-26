import { checkRouteToAdd, newRouteRefusalText, routeRows, routeState, routeStateText, withoutRoute, withRouteMoved, withUserRoute, type RouteHolder, type RouteRow, type RouteState, type RouteViewer } from '@solus/client-core/host-route-control'
import { serverConnections } from '@solus/client-core/server-connections'
import { LOCAL_SERVER_ID, type KnownHost } from '@solus/client-core/known-host'
import { hostCatalog } from '@solus/client-core/host-catalog'
import { ROUTE_CHECK_TIMEOUT_MS } from '@solus/contracts/host-routes'
import { serversStore } from '../../contexts'
import { hosts } from '../../contexts/hosts/hosts.svelte'

/**
 * A person's control of one host's routes on this client (docs/plans/host-routes.md
 * §12). The rules are in `host-route-control.ts`, shared with mobile; this store
 * holds what the desktop and web pages read, and applies each change to the
 * host catalog (this device's credential) and the host's live link.
 */
class HostRoutesStore {
  private get viewer(): RouteViewer {
    return { clientOrigin: globalThis.location?.origin ?? '', localHostId: serversStore.local?.installationId ?? null }
  }

  private known(serverId: string): KnownHost | undefined {
    return serversStore.knownHosts.find((server) => server.id === serverId)
  }

  isLocal(serverId: string): boolean {
    return !!serversStore.local && serverId === LOCAL_SERVER_ID
  }

  localRoutesStatus(serverId: string): string | null {
    if (!this.isLocal(serverId)) return null
    const fact = hosts.get(serverId).serverInfo
    if (fact.state === 'ready') return null
    return fact.state === 'error' ? 'Could not read this host’s routes.' : 'Reading this host’s routes…'
  }

  /** Remote routes are client preferences; local routes are the addresses this host advertises. */
  rowsFor(serverId: string): RouteRow[] {
    const server = this.known(serverId)
    if (server) return routeRows(server, this.viewer)
    if (!this.isLocal(serverId)) {
      const connected = serversStore.servers.find((host) => host.id === serverId)
      return connected ? routeRows(connected, this.viewer).map((row) => ({ ...row, canRemove: false })) : []
    }
    const fact = hosts.get(serverId).serverInfo
    return fact.state === 'ready'
      ? routeRows({ routes: fact.value.routes }, { clientOrigin: '' }).map((row) => ({ ...row, canRemove: false }))
      : []
  }

  /** Whether this client can change the host's routes: the control plane owns a cloud machine's. */
  canChange(serverId: string): boolean {
    return !this.isLocal(serverId) && !!this.known(serverId) && this.known(serverId)?.uplink?.kind !== 'cloud'
  }

  /**
   * Every route of the host with what it does now (docs/plans/host-routes.md §12):
   * in use, on standby, refused, blocked here, and so on. Read from the link; no
   * route is dialed to find out. This host's own addresses have no state: this
   * client does not dial them.
   */
  statesFor(serverId: string): Array<RouteRow & { state: RouteState | null; stateText: string | null }> {
    if (this.isLocal(serverId)) return this.rowsFor(serverId).map((row) => ({ ...row, state: null, stateText: null }))
    const dialed = serverConnections.dialedUrl(serverId)
    const readiness = serversStore.readinessFor(serverId)
    return this.rowsFor(serverId).map((row) => {
      const state = routeState(row, dialed, readiness)
      return { ...row, state, stateText: routeStateText(state, row) }
    })
  }

  /** Checks a typed address and saves it. Answers why not, or null when it is saved. */
  async add(serverId: string, address: string): Promise<string | null> {
    const server = this.known(serverId)
    if (!server) return null
    const checked = await checkRouteToAdd(fetch, {
      address,
      holder: server,
      identity: server,
      viewer: this.viewer,
      signal: AbortSignal.timeout(ROUTE_CHECK_TIMEOUT_MS),
    })
    if (!checked.ok) return newRouteRefusalText(checked.refusal)
    await this.apply(serverId, (holder) => withUserRoute(holder, checked.url, Date.now()))
    return null
  }

  move(serverId: string, url: string, step: -1 | 1): Promise<void> {
    return this.apply(serverId, (holder) => withRouteMoved(holder, url, step))
  }

  /** A pairing route is in the host's listing too: the catalog sends the listing again. */
  remove(serverId: string, url: string): Promise<void> {
    return this.apply(serverId, (holder) => withoutRoute(holder, url))
  }

  private async apply(serverId: string, change: (holder: RouteHolder) => RouteHolder): Promise<void> {
    await hostCatalog.changeRoutes(serverId, change)
    serverConnections.followRoutes(serverId)
  }
}

export const hostRoutesStore = new HostRoutesStore()
