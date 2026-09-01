import type { AuthStatus, DeviceCodePrompt, IpcContext, ServerCapabilities } from '../../shared/types'
import { TransportDisconnectedError } from '@client-core/ws-transport'

export interface PairToken {
  token: string
  code: string
  expiresAt: number
}

export interface ConnectionsServerInfo {
  host: string
  port: number
  allowLan: boolean
  installationId: string
  remoteAccess: boolean
  requireAuth: boolean
}

export interface ConnectionEndpoint {
  kind: 'loopback' | 'lan' | 'tailnet'
  label: string
  host: string
  port: number
}

export interface ConnectionSession {
  id: string
  deviceLabel: string
  deviceId: string | null
  connectedAt: number
  connectionCount: number
  connectionIds: string[]
}

export class ConnectionsStore {
  serverInfo = $state<ConnectionsServerInfo | null>(null)
  endpoints = $state<ConnectionEndpoint[]>([])
  sessions = $state<ConnectionSession[]>([])
  activePair = $state<PairToken | null>(null)
  refreshing = $state(false)
  capabilities = $state<ServerCapabilities | null>(null)

  providerStatus = $state<AuthStatus | null>(null)
  providerLoaded = $state(false)
  providerLoading = $state(false)
  providerConnecting = $state(false)
  providerPrompt = $state<DeviceCodePrompt | null>(null)
  providerError = $state<string | null>(null)

  private providerCancelling = false
  private deviceCodeUnsubscribe: (() => void) | null = null
  private deviceCodeSubscribers = 0

  async refreshServerMetadata(): Promise<void> {
    this.refreshing = true
    try {
      const [serverInfo, endpoints, sessions] = await Promise.all([
        window.solus.connectionsGetServerInfo(),
        window.solus.connectionsListEndpoints(),
        window.solus.connectionsListSessions(),
      ])
      this.serverInfo = serverInfo
      this.endpoints = endpoints
      this.sessions = sessions
    } catch (e) {
      console.error('connections refresh failed', e)
    } finally {
      this.refreshing = false
    }
  }

  async generatePairToken(): Promise<void> {
    try {
      this.activePair = await window.solus.connectionsGeneratePairToken()
    } catch (e) {
      console.error('generate pair token failed', e)
    }
  }

  async setRemoteAccess(remoteAccess: boolean): Promise<void> {
    try {
      const info = await window.solus.connectionsSetRemoteAccess({ remoteAccess })
      if (this.serverInfo) {
        this.serverInfo.remoteAccess = info.remoteAccess
        this.serverInfo.host = info.host
        this.serverInfo.port = info.port
        this.serverInfo.allowLan = info.allowLan
        this.serverInfo.requireAuth = info.requireAuth
      }
      await this.refreshServerMetadata()
    } catch (e) {
      console.error('set remote access failed', e)
    }
  }

  async refreshCapabilities(): Promise<void> {
    try {
      this.capabilities = await window.solus.getServerCapabilities()
    } catch (e) {
      if (e instanceof TransportDisconnectedError) return
      console.error('getServerCapabilities failed', e)
    }
  }

  get desktopHandlersAvailable(): boolean {
    return this.capabilities?.desktopHandlers !== false
  }

  async revokeDevice(deviceId: string): Promise<void> {
    try {
      await window.solus.connectionsRevokeDevice({ deviceId })
      await this.refreshServerMetadata()
    } catch (e) {
      console.error('revoke failed', e)
    }
  }

  async refreshProviderStatus(ctx: IpcContext): Promise<void> {
    this.providerLoading = true
    try {
      this.providerStatus = await window.solus.providerStatus($state.snapshot(ctx))
    } catch (e) {
      console.error('providerStatus failed', e)
    } finally {
      this.providerLoaded = true
      this.providerLoading = false
    }
  }

  async connectProvider(ctx: IpcContext): Promise<void> {
    if (this.providerConnecting) return
    this.providerError = null
    this.providerCancelling = false
    this.providerConnecting = true
    try {
      this.providerStatus = await window.solus.providerConnect($state.snapshot(ctx))
      this.providerLoaded = true
    } catch (e) {
      if (!this.providerCancelling) this.providerError = e instanceof Error ? e.message : String(e)
    } finally {
      this.providerConnecting = false
      this.providerPrompt = null
      this.providerCancelling = false
    }
  }

  async cancelProviderConnect(ctx: IpcContext): Promise<void> {
    this.providerCancelling = true
    this.providerPrompt = null
    try {
      await window.solus.providerCancelConnect($state.snapshot(ctx))
    } catch (e) {
      console.error('providerCancelConnect failed', e)
    }
  }

  async disconnectProvider(ctx: IpcContext): Promise<void> {
    try {
      await window.solus.providerDisconnect($state.snapshot(ctx))
      this.providerStatus = { connected: false }
      this.providerLoaded = true
    } catch (e) {
      console.error('providerDisconnect failed', e)
    }
  }

  listenForProviderDeviceCodes(): () => void {
    this.deviceCodeSubscribers++
    if (!this.deviceCodeUnsubscribe) {
      this.deviceCodeUnsubscribe = window.solus.onProviderDeviceCode((prompt) => {
        this.providerPrompt = prompt
      })
    }
    return () => {
      this.deviceCodeSubscribers = Math.max(0, this.deviceCodeSubscribers - 1)
      if (this.deviceCodeSubscribers > 0) return
      this.deviceCodeUnsubscribe?.()
      this.deviceCodeUnsubscribe = null
    }
  }
}

export const connectionsStore = new ConnectionsStore()
