import type { AgentTaskLifecyclePolicy, AuthStatus, DeviceCodePrompt, IpcContext, ServerCapabilities } from '../../../shared/types'
import { TransportDisconnectedError } from '@client-core/ws-transport'
import { serverConnections } from '@client-core/server-connections'

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
  // primary-host by decision pending WP6 host framing (docs/plans/multi-host-parity.md)
  serverInfo = $state<ConnectionsServerInfo | null>(null)
  endpoints = $state<ConnectionEndpoint[]>([])
  sessions = $state<ConnectionSession[]>([])
  activePair = $state<PairToken | null>(null)
  refreshing = $state(false)
  remoteAccessUpdating = $state(false)
  agentTaskLifecyclePolicyUpdating = $state(false)
  capabilities = $state<ServerCapabilities | null>(null)

  providerStatus = $state<AuthStatus | null>(null)
  providerLoaded = $state(false)
  providerLoading = $state(false)
  providerConnecting = $state(false)
  providerPrompt = $state<DeviceCodePrompt | null>(null)

  private providerCancelling = false
  private deviceCodeUnsubscribe: (() => void) | null = null
  private deviceCodeSubscribers = 0

  async refreshServerMetadata(): Promise<void> {
    this.refreshing = true
    try {
      const [serverInfo, endpoints, sessions] = await Promise.all([
        serverConnections.primaryApi().connectionsGetServerInfo(),
        serverConnections.primaryApi().connectionsListEndpoints(),
        serverConnections.primaryApi().connectionsListSessions(),
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
      this.activePair = await serverConnections.primaryApi().connectionsGeneratePairToken()
    } catch (e) {
      console.error('generate pair token failed', e)
    }
  }

  async setRemoteAccess(remoteAccess: boolean): Promise<void> {
    if (!this.serverInfo || this.remoteAccessUpdating) return
    const previousRemoteAccess = this.serverInfo.remoteAccess
    this.serverInfo.remoteAccess = remoteAccess
    this.remoteAccessUpdating = true
    try {
      const info = await serverConnections.primaryApi().connectionsSetRemoteAccess({ remoteAccess })
      this.serverInfo.remoteAccess = info.remoteAccess
      this.serverInfo.host = info.host
      this.serverInfo.port = info.port
      this.serverInfo.allowLan = info.allowLan
      this.serverInfo.requireAuth = info.requireAuth
      await this.refreshServerMetadata()
    } catch (e) {
      this.serverInfo.remoteAccess = previousRemoteAccess
      console.error('set remote access failed', e)
    } finally {
      this.remoteAccessUpdating = false
    }
  }

  async refreshCapabilities(): Promise<void> {
    try {
      this.capabilities = await serverConnections.primaryApi().getServerCapabilities()
    } catch (e) {
      if (e instanceof TransportDisconnectedError) return
      console.error('getServerCapabilities failed', e)
    }
  }

  get desktopHandlersAvailable(): boolean {
    return this.capabilities?.desktopHandlers !== false
  }

  /** Where this host's folder picker starts. Empty clears it back to the home folder. */
  async setProjectsBaseDirectory(path: string): Promise<void> {
    const result = await serverConnections.primaryApi().setProjectsBaseDirectory(path)
    if (this.capabilities) this.capabilities.projectsBaseDirectory = result.projectsBaseDirectory
  }

  async setAgentTaskLifecyclePolicy(policy: AgentTaskLifecyclePolicy): Promise<void> {
    if (!this.capabilities || this.agentTaskLifecyclePolicyUpdating) return
    const previousPolicy = this.capabilities.agentTaskLifecyclePolicy
    this.capabilities.agentTaskLifecyclePolicy = policy
    this.agentTaskLifecyclePolicyUpdating = true
    try {
      const result = await serverConnections.primaryApi().setAgentTaskLifecyclePolicy(policy)
      this.capabilities.agentTaskLifecyclePolicy = result.agentTaskLifecyclePolicy
    } catch (e) {
      this.capabilities.agentTaskLifecyclePolicy = previousPolicy
      console.error('set agent task lifecycle policy failed', e)
    } finally {
      this.agentTaskLifecyclePolicyUpdating = false
    }
  }

  async revokeDevice(deviceId: string): Promise<void> {
    try {
      await serverConnections.primaryApi().connectionsRevokeDevice({ deviceId })
      await this.refreshServerMetadata()
    } catch (e) {
      console.error('revoke failed', e)
    }
  }

  async refreshProviderStatus(ctx: IpcContext): Promise<void> {
    this.providerLoading = true
    try {
      this.providerStatus = await serverConnections.primaryApi().providerStatus($state.snapshot(ctx))
    } catch (e) {
      console.error('providerStatus failed', e)
    } finally {
      this.providerLoaded = true
      this.providerLoading = false
    }
  }

  async connectProvider(ctx: IpcContext): Promise<void> {
    if (this.providerConnecting) return
    this.providerCancelling = false
    this.providerConnecting = true
    try {
      this.providerStatus = await serverConnections.primaryApi().providerConnect($state.snapshot(ctx))
      this.providerLoaded = true
    } catch (e) {
      if (this.providerCancelling) return
      throw e
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
      await serverConnections.primaryApi().providerCancelConnect($state.snapshot(ctx))
    } catch (e) {
      console.error('providerCancelConnect failed', e)
    }
  }

  async disconnectProvider(ctx: IpcContext): Promise<void> {
    try {
      await serverConnections.primaryApi().providerDisconnect($state.snapshot(ctx))
      this.providerStatus = { connected: false }
      this.providerLoaded = true
    } catch (e) {
      console.error('providerDisconnect failed', e)
    }
  }

  listenForProviderDeviceCodes(): () => void {
    this.deviceCodeSubscribers++
    if (!this.deviceCodeUnsubscribe) {
      this.deviceCodeUnsubscribe = serverConnections.eventsForPrimary().subscribe('provider.deviceCodeReceived', (prompt) => {
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
