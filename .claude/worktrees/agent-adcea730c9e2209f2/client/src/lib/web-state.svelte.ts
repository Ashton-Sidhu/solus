import type { ConnectionStatus } from '@client-core/ws-transport'
import type { SavedServer } from '@client-core/server-registry'

class WebState {
  connectionStatus: ConnectionStatus = $state('disconnected')
  connectionAttempt: number = $state(0)
  hasConnected = $state(false)
  connectedServer: SavedServer | null = $state(null)
  sidebarDrawerOpen: boolean = $state(false)

  setConnectionStatus(status: ConnectionStatus, attempt: number) {
    this.connectionStatus = status
    this.connectionAttempt = attempt
    if (status === 'connected') this.hasConnected = true
  }

  setConnectedServer(server: SavedServer | null) {
    this.connectedServer = server
    if (!server) this.hasConnected = false
  }

  toggleSidebarDrawer() {
    this.sidebarDrawerOpen = !this.sidebarDrawerOpen
  }

  closeSidebarDrawer() {
    this.sidebarDrawerOpen = false
  }
}

export const webState = new WebState()
