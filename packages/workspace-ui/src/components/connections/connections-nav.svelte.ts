import { hostCatalog } from "@solus/client-core/host-catalog"
import type { AddWay } from "../fleet/lib/fleet-model"

/**
 * Where the Connections page is: the fleet, one host's page, or the Add page
 * (docs/plans/host-fleet.md D8). Held outside the
 * page so the settings breadcrumb can name the host without the page telling it,
 * and so leaving Connections altogether can put the page back on the list.
 */
class ConnectionsNav {
  hostId = $state<string | null>(null)

  tab = $state("overview")

  /** The Add page is open. */
  isAdding = $state(false)

  /** The way a link chose for the Add page (the map's "New machine"); null opens it with no way chosen. */
  addWay = $state<AddWay | null>(null)

  constructor() {
    // A forgotten host's page closes with it. Left open, the page would come
    // back the moment the host is listed again, as if Forget did nothing.
    hostCatalog.onForgotten((server) => {
      if (server.id === this.hostId) this.back()
    })
  }

  /** A page is open over the fleet: a host's, or the Add page. */
  get isOnPage(): boolean {
    return this.hostId !== null || this.isAdding
  }

  open(hostId: string, tab = "overview"): void {
    this.tab = tab
    this.isAdding = false
    this.hostId = hostId
  }

  openAdd(way: AddWay | null = null): void {
    this.hostId = null
    this.addWay = way
    this.isAdding = true
  }

  back(): void {
    this.hostId = null
    this.isAdding = false
    this.addWay = null
  }
}

export const connectionsNav = new ConnectionsNav()
