import type { ConnectionStatus } from '@solus/client-core/ws-transport'

class WebState {
  connectionStatus: ConnectionStatus = $state('disconnected')
  connectionAttempt: number = $state(0)
  hasConnected = $state(false)

  serverSetupOpen: boolean = $state(false)

  setConnectionStatus(status: ConnectionStatus, attempt: number) {
    this.connectionStatus = status
    this.connectionAttempt = attempt
    if (status === 'connected') this.hasConnected = true
  }

  openServerSetup() {
    this.serverSetupOpen = true
  }

  closeServerSetup() {
    this.serverSetupOpen = false
  }
}

export const webState = new WebState()
