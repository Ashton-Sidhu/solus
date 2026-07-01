import type { ConnectionStatus } from '../transport/ws-transport'
import type { SavedServer } from '../transport/server-registry'

class WebState {
  connectionStatus: ConnectionStatus = $state('disconnected')
  connectionAttempt: number = $state(0)
  connectedServer: SavedServer | null = $state(null)
  sidebarDrawerOpen: boolean = $state(false)

  setConnectionStatus(status: ConnectionStatus, attempt: number) {
    this.connectionStatus = status
    this.connectionAttempt = attempt
  }

  setConnectedServer(server: SavedServer | null) {
    this.connectedServer = server
  }

  toggleSidebarDrawer() {
    this.sidebarDrawerOpen = !this.sidebarDrawerOpen
  }

  closeSidebarDrawer() {
    this.sidebarDrawerOpen = false
  }
}

export const webState = new WebState()
