import { onServerRemoving } from "@solus/client-core/server-registry"

/**
 * Where the Connections page is: the list, or one host's page. Held outside the
 * page so the settings breadcrumb can name the host without the page telling it,
 * and so leaving Connections altogether can put the page back on the list.
 */
class ConnectionsNav {
  hostId = $state<string | null>(null)

  tab = $state("overview")

  constructor() {
    // A forgotten host's page closes with it. Left open, the page would come
    // back the moment the host is listed again, as if Forget did nothing.
    onServerRemoving((server) => {
      if (server.id === this.hostId) this.back()
    })
  }

  open(hostId: string, tab = "overview"): void {
    this.tab = tab
    this.hostId = hostId
  }

  back(): void {
    this.hostId = null
  }
}

export const connectionsNav = new ConnectionsNav()
