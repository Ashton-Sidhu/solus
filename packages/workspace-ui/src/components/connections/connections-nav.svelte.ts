/**
 * Where the Connections page is: the list, or one host's page. Held outside the
 * page so the settings breadcrumb can name the host without the page telling it,
 * and so leaving Connections altogether can put the page back on the list.
 */
class ConnectionsNav {
  hostId = $state<string | null>(null)

  open(hostId: string): void {
    this.hostId = hostId
  }

  back(): void {
    this.hostId = null
  }
}

export const connectionsNav = new ConnectionsNav()
