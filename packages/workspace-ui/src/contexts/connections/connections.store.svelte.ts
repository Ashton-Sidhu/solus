import type { AgentTaskLifecyclePolicy, AuthStatus, DeviceCodePrompt, IpcContext, ServerCapabilities } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'
import { TransportDisconnectedError } from '@solus/client-core/ws-transport'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { SvelteMap } from 'svelte/reactivity'

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
  trustLocalNetwork: boolean
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
  // One host's server settings at a time: every method names its host
  // explicitly (the Settings page passes its selected host).
  serverInfo = $state<ConnectionsServerInfo | null>(null)
  endpoints = $state<ConnectionEndpoint[]>([])
  sessions = $state<ConnectionSession[]>([])
  activePair = $state<PairToken | null>(null)
  refreshing = $state(false)
  remoteAccessUpdating = $state(false)
  trustLocalNetworkUpdating = $state(false)
  agentTaskLifecyclePolicyUpdating = $state(false)
  capabilities = $state<ServerCapabilities | null>(null)
  private capabilitiesByServer = new SvelteMap<string, ServerCapabilities>()
  private metadataServerId: string | null = null

  providerStatus = $state<AuthStatus | null>(null)
  providerLoaded = $state(false)
  providerLoading = $state(false)
  providerConnecting = $state(false)
  providerPrompt = $state<DeviceCodePrompt | null>(null)

  private providerCancelling = false
  private providerServerId: string | null = null
  private deviceCodeUnsubscribe: (() => void) | null = null
  private deviceCodeSubscribers = 0

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
        api.connectionsGetServerInfo(),
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

  capabilitiesFor(serverId: string): ServerCapabilities | null {
    return this.capabilitiesByServer.get(serverId) ?? null
  }

  async refreshCapabilities(target: { serverId: string; api?: HostApi }): Promise<void> {
    try {
      const api = target.api ?? serverConnections.apiFor(target.serverId)
      const capabilities = await api.getServerCapabilities()
      this.capabilitiesByServer.set(target.serverId, capabilities)
      // The unqualified mirror backs client-wide gates and follows the
      // new-work default host.
      if (target.serverId === serverConnections.defaultServerId()) this.capabilities = capabilities
    } catch (e) {
      if (e instanceof TransportDisconnectedError) return
      console.error('getServerCapabilities failed', e)
    }
  }

  get desktopHandlersAvailable(): boolean {
    return this.capabilities?.desktopHandlers !== false
  }

  /** Where this host's folder picker starts. Empty clears it back to the home folder. */
  async setProjectsBaseDirectory(serverId: string, path: string): Promise<void> {
    const result = await serverConnections.apiFor(serverId).setProjectsBaseDirectory(path)
    const hostCapabilities = this.capabilitiesByServer.get(serverId)
    if (hostCapabilities) hostCapabilities.projectsBaseDirectory = result.projectsBaseDirectory
    if (this.capabilities && serverId === serverConnections.defaultServerId()) {
      this.capabilities.projectsBaseDirectory = result.projectsBaseDirectory
    }
  }

  async setAgentTaskLifecyclePolicy(
    policy: AgentTaskLifecyclePolicy,
    target: { serverId: string; api?: HostApi },
  ): Promise<void> {
    // The unqualified mirror answers for the default host when its per-host
    // record was never loaded.
    const capabilities = this.capabilitiesFor(target.serverId)
      ?? (target.serverId === serverConnections.defaultServerId() ? this.capabilities : null)
    if (!capabilities || this.agentTaskLifecyclePolicyUpdating) return
    const previousPolicy = capabilities.agentTaskLifecyclePolicy
    capabilities.agentTaskLifecyclePolicy = policy
    this.agentTaskLifecyclePolicyUpdating = true
    try {
      const api = target.api ?? serverConnections.apiFor(target.serverId)
      const result = await api.setAgentTaskLifecyclePolicy(policy)
      capabilities.agentTaskLifecyclePolicy = result.agentTaskLifecyclePolicy
    } catch (e) {
      capabilities.agentTaskLifecyclePolicy = previousPolicy
      console.error('set agent task lifecycle policy failed', e)
    } finally {
      this.agentTaskLifecyclePolicyUpdating = false
    }
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
