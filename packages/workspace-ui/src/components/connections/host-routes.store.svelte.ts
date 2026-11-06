import { checkRouteToAdd, newRouteRefusalText, routeInUse, routeRows, withoutRoute, withRouteMoved, withUserRoute, type RouteRow, type RouteViewer } from '@solus/client-core/host-route-control'
import { serverConnections } from '@solus/client-core/server-connections'
import { changeServer, upsertServer, type SavedServer } from '@solus/client-core/server-registry'
import { ROUTE_CHECK_TIMEOUT_MS, routesFrom } from '@solus/contracts/host-routes'
import { serversStore } from '../../contexts'

/**
 * A person's control of one host's routes on this client (docs/plans/host-routes.md
 * §12). The rules are in `host-route-control.ts`, shared with mobile; this store
 * holds what the desktop and web pages read, and applies each change to the
 * saved host and its live link.
 */
class HostRoutesStore {
  private get viewer(): RouteViewer {
    return { clientOrigin: globalThis.location?.origin ?? '', localHostId: serversStore.local?.installationId ?? null }
  }

  private saved(serverId: string): SavedServer | undefined {
    return serversStore.remotes.find((server) => server.id === serverId)
  }

  /** Every route of a saved host, in the order this client tries them. Empty for this computer's own host. */
  rowsFor(serverId: string): RouteRow[] {
    const server = this.saved(serverId)
    return server ? routeRows(server, this.viewer) : []
  }

  /** Whether this client can change the host's routes: Solus cloud owns a managed host's. */
  canChange(serverId: string): boolean {
    return this.saved(serverId)?.uplink?.kind !== 'managed'
  }

  /** The route the link is on while the host is connected; null while it is not. */
  inUseFor(serverId: string): string | null {
    const isReady = serversStore.readinessFor(serverId).readiness === 'ready'
    return routeInUse(this.rowsFor(serverId), serverConnections.dialedUrl(serverId), isReady)
  }

  /** Checks a typed address and saves it. Answers why not, or null when it is saved. */
  async add(serverId: string, address: string): Promise<string | null> {
    const server = this.saved(serverId)
    if (!server) return null
    const checked = await checkRouteToAdd(fetch, {
      address,
      holder: server,
      identity: server,
      viewer: this.viewer,
      signal: AbortSignal.timeout(ROUTE_CHECK_TIMEOUT_MS),
    })
    if (!checked.ok) return newRouteRefusalText(checked.refusal)
    this.apply(serverId, (saved) => withUserRoute(saved, checked.url, Date.now()))
    return null
  }

  move(serverId: string, url: string, step: -1 | 1): void {
    this.apply(serverId, (saved) => withRouteMoved(saved, url, step))
  }

  remove(serverId: string, url: string): void {
    const paired = routesFrom(this.saved(serverId)?.routes ?? [], 'pairing').some((route) => route.url === url)
    const changed = this.apply(serverId, (saved) => withoutRoute(saved, url))
    // A pairing route is in the host's listing, so the listing changes with it.
    if (changed && paired) upsertServer(changed)
  }

  private apply(serverId: string, change: (server: SavedServer) => SavedServer): SavedServer | null {
    const changed = changeServer(serverId, change)
    serversStore.refreshServers()
    serverConnections.followRoutes(serverId)
    return changed
  }
}

export const hostRoutesStore = new HostRoutesStore()
