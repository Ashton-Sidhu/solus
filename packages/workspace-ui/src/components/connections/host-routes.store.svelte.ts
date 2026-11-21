import { checkRouteToAdd, newRouteRefusalText, routeInUse, routeRows, withoutRoute, withRouteMoved, withUserRoute, type RouteHolder, type RouteRow, type RouteViewer } from '@solus/client-core/host-route-control'
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
    return serversStore.remotes.find((server) => server.id === serverId)
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

  /** Whether this client can change the host's routes: Solus cloud owns a managed host's. */
  canChange(serverId: string): boolean {
    return !this.isLocal(serverId) && !!this.known(serverId) && this.known(serverId)?.uplink?.kind !== 'managed'
  }

  /** The route the link is on while the host is connected; null while it is not. */
  inUseFor(serverId: string): string | null {
    const isReady = serversStore.readinessFor(serverId).readiness === 'ready'
    return routeInUse(this.rowsFor(serverId), serverConnections.dialedUrl(serverId), isReady)
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
