import type { AuthStatus, DeviceCodePrompt, IpcContext } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { hosts } from '../hosts/hosts.svelte'

export interface PairToken {
  token: string
  code: string
  expiresAt: number
}

export type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'

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
  // One host's server settings at a time: every method names its host
  // explicitly (the Settings page passes its selected host).
  serverInfo = $state<ConnectionsServerInfo | null>(null)
  endpoints = $state<ConnectionEndpoint[]>([])
  sessions = $state<ConnectionSession[]>([])
  activePair = $state<PairToken | null>(null)
  refreshing = $state(false)
  remoteAccessUpdating = $state(false)
  trustLocalNetworkUpdating = $state(false)
  private metadataServerId: string | null = null

  providerStatus = $state<AuthStatus | null>(null)
  providerLoaded = $state(false)
  providerLoading = $state(false)
  providerConnecting = $state(false)
  providerPrompt = $state<DeviceCodePrompt | null>(null)

  private providerCancelling = false
  private providerServerId = $state<string | null>(null)
  private deviceCodeUnsubscribe: (() => void) | null = null
  private deviceCodeSubscribers = 0

  /** The GitHub status last read, only when it was read from this host. */
  providerStatusFor(serverId: string | null): AuthStatus | null {
    return serverId && this.providerServerId === serverId ? this.providerStatus : null
  }

  async refreshServerMetadata(serverId: string): Promise<void> {
    if (this.metadataServerId !== serverId) {
      this.metadataServerId = serverId
      this.serverInfo = null
      this.endpoints = []
      this.sessions = []
      this.activePair = null
    }
    this.refreshing = true
    try {
      const api = serverConnections.apiFor(serverId)
      const [serverInfo, endpoints, sessions] = await Promise.all([
        serverConnections.serverInfoFor(serverId, true),
        api.connectionsListEndpoints(),
        api.connectionsListSessions(),
      ])
      if (this.metadataServerId === serverId) {
        this.serverInfo = serverInfo
        this.endpoints = endpoints
        this.sessions = sessions
      }
    } catch (e) {
      console.error('connections refresh failed', e)
    } finally {
      if (this.metadataServerId === serverId) this.refreshing = false
    }
  }

  async generatePairToken(serverId: string): Promise<void> {
    try {
      this.activePair = await serverConnections.apiFor(serverId).connectionsGeneratePairToken()
    } catch (e) {
      console.error('generate pair token failed', e)
    }
  }

  async setRemoteAccess(serverId: string, remoteAccess: boolean): Promise<void> {
    if (!this.serverInfo || this.remoteAccessUpdating) return
    const previousRemoteAccess = this.serverInfo.remoteAccess
    this.serverInfo.remoteAccess = remoteAccess
    this.remoteAccessUpdating = true
    try {
      const info = await serverConnections.apiFor(serverId).connectionsSetRemoteAccess({ remoteAccess })
      this.serverInfo.remoteAccess = info.remoteAccess
      this.serverInfo.host = info.host
      this.serverInfo.port = info.port
      this.serverInfo.allowLan = info.allowLan
      this.serverInfo.requireAuth = info.requireAuth
      await this.refreshServerMetadata(serverId)
    } catch (e) {
      this.serverInfo.remoteAccess = previousRemoteAccess
      console.error('set remote access failed', e)
    } finally {
      this.remoteAccessUpdating = false
    }
  }

  async setTrustLocalNetwork(serverId: string, trustLocalNetwork: boolean): Promise<void> {
    if (!this.serverInfo || this.trustLocalNetworkUpdating) return
    const previousTrustLocalNetwork = this.serverInfo.trustLocalNetwork
    this.serverInfo.trustLocalNetwork = trustLocalNetwork
    this.trustLocalNetworkUpdating = true
    try {
      const result = await serverConnections.apiFor(serverId).connectionsSetTrustLocalNetwork({ trustLocalNetwork })
      this.serverInfo.trustLocalNetwork = result.trustLocalNetwork
    } catch (e) {
      this.serverInfo.trustLocalNetwork = previousTrustLocalNetwork
      console.error('set trust local network failed', e)
    } finally {
      this.trustLocalNetworkUpdating = false
    }
  }

  /** Where this host's new projects and clones land. Empty clears it back to the host default. */
  async setProjectsBaseDirectory(serverId: string, path: string): Promise<void> {
    const result = await serverConnections.apiFor(serverId).setProjectsBaseDirectory(path)
    hosts.get(serverId).patchCapabilities(result)
  }

  async revokeDevice(serverId: string, deviceId: string): Promise<void> {
    try {
      await serverConnections.apiFor(serverId).connectionsRevokeDevice({ deviceId })
      await this.refreshServerMetadata(serverId)
    } catch (e) {
      console.error('revoke failed', e)
    }
  }

  async refreshProviderStatus(serverId: string, ctx: IpcContext): Promise<void> {
    if (this.providerServerId !== serverId) {
      this.providerServerId = serverId
      this.providerStatus = null
      this.providerLoaded = false
    }
    this.providerLoading = true
    try {
      const status = await serverConnections.apiFor(serverId).providerStatus($state.snapshot(ctx))
      if (this.providerServerId === serverId) this.providerStatus = status
    } catch (e) {
      console.error('providerStatus failed', e)
    } finally {
      if (this.providerServerId === serverId) {
        this.providerLoaded = true
        this.providerLoading = false
      }
    }
  }

  async connectProvider(serverId: string, ctx: IpcContext): Promise<void> {
    if (this.providerConnecting) return
    this.providerCancelling = false
    this.providerServerId = serverId
    this.providerConnecting = true
    try {
      const status = await serverConnections.apiFor(serverId).providerConnect($state.snapshot(ctx))
      if (this.providerServerId === serverId) {
        this.providerStatus = status
        this.providerLoaded = true
      }
    } catch (e) {
      if (this.providerCancelling) return
      throw e
    } finally {
      this.providerConnecting = false
      this.providerPrompt = null
      this.providerCancelling = false
    }
  }

  async cancelProviderConnect(serverId: string, ctx: IpcContext): Promise<void> {
    this.providerCancelling = true
    this.providerPrompt = null
    try {
      await serverConnections.apiFor(serverId).providerCancelConnect($state.snapshot(ctx))
    } catch (e) {
      console.error('providerCancelConnect failed', e)
    }
  }

  async disconnectProvider(serverId: string, ctx: IpcContext): Promise<void> {
    try {
      await serverConnections.apiFor(serverId).providerDisconnect($state.snapshot(ctx))
      this.providerStatus = { connected: false }
      this.providerLoaded = true
    } catch (e) {
      console.error('providerDisconnect failed', e)
    }
  }

  listenForProviderDeviceCodes(): () => void {
    this.deviceCodeSubscribers++
    if (!this.deviceCodeUnsubscribe) {
      this.deviceCodeUnsubscribe = subscribeAllHosts('provider.deviceCodeReceived', (_serverId, prompt) => {
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
