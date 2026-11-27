import type { AuthStatus, DeviceCodePrompt, IpcContext } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { SvelteMap } from 'svelte/reactivity'
import { hosts } from '../hosts/hosts.svelte'

export interface PairToken {
  token: string
  code: string
  expiresAt: number
}

export type { ConnectionsServerInfo, PairedDevice } from '@solus/contracts/host-api'
import type { AppAccess, AppAddressSource, ConnectionsServerInfo, PairedDevice, SolusAPI, TailscaleServeStatus } from '@solus/contracts/host-api'

/** Where an outside app reaches a host's tools over MCP (plans/035 §10). */
export type AppEndpoint = Awaited<ReturnType<SolusAPI['connectionsAppEndpoint']>>
/** The host's own test of one of its addresses, from outside. `url` is the address tested: a result for another url is stale. */
export type AppAddressTestState =
  | { kind: 'running'; url: string }
  | { kind: 'done'; url: string; reachable: boolean; reason: string | null; checkedAt: number }
  | { kind: 'error'; url: string; message: string }
/** The last test of each address of one host, by source. */
export type AppAddressTests = Partial<Record<AppAddressSource, AppAddressTestState>>
/** A one-time code that approves an outside app on its sign-in page. */
export type AppPairingCode = Awaited<ReturnType<SolusAPI['connectionsCreateAppPairingCode']>>

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
  constructor() {
    subscribeAllHosts('host.tailscaleServeChanged', (serverId, status) => {
      if (this.metadataServerId === serverId && this.serverInfo) {
        this.serverInfo.tailscaleServe = status
        void this.refreshServerMetadata(serverId)
      }
      // Serve or Funnel changes the addresses apps reach the host at.
      if (this.appEndpoints.has(serverId)) {
        this.appTailscale.set(serverId, status)
        void this.loadAppEndpoint(serverId)
      }
    })
  }
  // One host's server settings at a time: every method names its host
  // explicitly (the Settings page passes its selected host).
  serverInfo = $state<ConnectionsServerInfo | null>(null)
  endpoints = $state<ConnectionEndpoint[]>([])
  sessions = $state<ConnectionSession[]>([])
  /** The devices this host paired, connected or not. Only the host's owner may read them. */
  pairedDevices = $state<PairedDevice[]>([])
  pairedDevicesLoaded = $state(false)
  pairedDevicesError = $state<string | null>(null)
  activePair = $state<PairToken | null>(null)
  refreshing = $state(false)
  remoteAccessUpdating = $state(false)
  remoteAccessError = $state<string | null>(null)
  tailscaleServeUpdating = $state(false)
  tailscaleServeError = $state<string | null>(null)
  trustLocalNetworkUpdating = $state(false)
  private metadataServerId: string | null = null

  // Outside apps (Use Solus in other apps), by host: the dialog and Sharing & access may show two hosts.
  private readonly appEndpoints = new SvelteMap<string, { endpoint: AppEndpoint | null; error: string | null }>()
  private readonly appEndpointReads = new Map<string, number>()
  private readonly appAddressTests = new SvelteMap<string, AppAddressTests>()
  /** Tailscale Serve and Funnel on the host; null when Tailscale did not answer. */
  private readonly appTailscale = new SvelteMap<string, TailscaleServeStatus | null>()
  /** The host whose Tailscale Serve or Funnel is changing. */
  appTailscaleBusyServerId = $state<string | null>(null)
  private readonly appTailscaleErrors = new SvelteMap<string, string>()
  // The pairing code, for one host at a time.
  private appPairingCode = $state<AppPairingCode | null>(null)
  appPairingCodeCreating = $state(false)
  private appPairingCodeError = $state<string | null>(null)
  private appPairingCodeServerId = $state<string | null>(null)

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

  /**
   * Reads one host's server settings now and every five seconds, until the returned
   * stop. Settings → Sharing & access holds it while it shows.
   */
  watchServerMetadata(serverId: string): () => void {
    void this.refreshServerMetadata(serverId)
    const interval = setInterval(() => void this.refreshServerMetadata(serverId), 5000)
    return () => clearInterval(interval)
  }

  async refreshServerMetadata(serverId: string): Promise<void> {
    if (this.metadataServerId !== serverId) {
      this.metadataServerId = serverId
      this.remoteAccessError = null
      this.tailscaleServeError = null
      this.serverInfo = null
      this.endpoints = []
      this.sessions = []
      this.pairedDevices = []
      this.pairedDevicesLoaded = false
      this.pairedDevicesError = null
      this.activePair = null
    }
    this.refreshing = true
    try {
      const api = serverConnections.apiFor(serverId)
      const [serverInfo, endpoints, sessions] = await Promise.all([
        serverConnections.serverInfoFor(serverId, true),
        api.connectionsListEndpoints(),
        api.connectionsListSessions(),
        this.refreshPairedDevices(serverId),
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

  /** A refused read shows its reason in the paired devices section; the rest of the tab still shows. */
  private async refreshPairedDevices(serverId: string): Promise<void> {
    try {
      const devices = await serverConnections.apiFor(serverId).connectionsListDevices()
      if (this.metadataServerId !== serverId) return
      this.pairedDevices = devices
      this.pairedDevicesError = null
    } catch (e) {
      if (this.metadataServerId === serverId) this.pairedDevicesError = e instanceof Error ? e.message : String(e)
    } finally {
      if (this.metadataServerId === serverId) this.pairedDevicesLoaded = true
    }
  }

  async generatePairToken(serverId: string): Promise<void> {
    try {
      this.activePair = await serverConnections.apiFor(serverId).connectionsGeneratePairToken()
    } catch (e) {
      console.error('generate pair token failed', e)
    }
  }

  /** Where outside apps reach this host; null until read. */
  appEndpointFor(serverId: string): AppEndpoint | null {
    return this.appEndpoints.get(serverId)?.endpoint ?? null
  }

  appEndpointErrorFor(serverId: string): string | null {
    return this.appEndpoints.get(serverId)?.error ?? null
  }

  appAddressTestsFor(serverId: string): AppAddressTests {
    return this.appAddressTests.get(serverId) ?? {}
  }

  /** Tailscale on the host: undefined until read, null when Tailscale did not answer. */
  appTailscaleFor(serverId: string): TailscaleServeStatus | null | undefined {
    return this.appTailscale.get(serverId)
  }

  appTailscaleErrorFor(serverId: string): string | null {
    return this.appTailscaleErrors.get(serverId) ?? null
  }

  /** Reads where outside apps reach this host, and its Tailscale state. An older read never overwrites a newer one. */
  async loadAppEndpoint(serverId: string): Promise<void> {
    const read = (this.appEndpointReads.get(serverId) ?? 0) + 1
    this.appEndpointReads.set(serverId, read)
    const api = serverConnections.apiFor(serverId)
    const [endpoint, tailscale] = await Promise.allSettled([
      (async () => api.connectionsAppEndpoint())(),
      (async () => api.connectionsGetTailscaleServe())(),
    ])
    if (this.appEndpointReads.get(serverId) !== read) return
    this.appEndpoints.set(serverId, endpoint.status === 'fulfilled'
      ? { endpoint: endpoint.value, error: null }
      : { endpoint: null, error: endpoint.reason instanceof Error ? endpoint.reason.message : String(endpoint.reason) })
    this.appTailscale.set(serverId, tailscale.status === 'fulfilled' ? tailscale.value : null)
  }

  /** The host asks its own address of this source from outside, as an app would. One test at a time for each address. */
  async testAppAddress(serverId: string, source: AppAddressSource): Promise<void> {
    const url = this.appEndpointFor(serverId)?.addresses.find((address) => address.source === source)?.url
    const current = this.appAddressTestsFor(serverId)[source]
    if (!url || (current?.kind === 'running' && current.url === url)) return
    const running: AppAddressTestState = { kind: 'running', url }
    this.#setAddressTest(serverId, source, running)
    let answer: AppAddressTestState
    try {
      const result = await serverConnections.apiFor(serverId).connectionsTestAppAddress({ source })
      answer = { kind: 'done', url, reachable: result.reachable, reason: result.reason, checkedAt: Date.now() }
    } catch (e) {
      answer = { kind: 'error', url, message: e instanceof Error ? e.message : String(e) }
    }
    if (this.appAddressTestsFor(serverId)[source] === running) this.#setAddressTest(serverId, source, answer)
  }

  /** "Check again": the next gate tests the address again. */
  forgetAppAddressTests(serverId: string): void {
    this.appAddressTests.delete(serverId)
  }

  /** Turns Tailscale Funnel on or off, then reads the addresses again. Local owner only. */
  async setAppTailscaleFunnel(serverId: string, enabled: boolean): Promise<void> {
    await this.#changeAppTailscale(serverId, (api) => api.connectionsSetTailscaleFunnel({ enabled }))
  }

  /** Turns Tailscale Serve on at the port it last had (443 by default), then reads the addresses again. Local owner only. */
  async enableAppTailscaleServe(serverId: string): Promise<void> {
    const port = this.appTailscale.get(serverId)?.port ?? 443
    await this.#changeAppTailscale(serverId, (api) => api.connectionsEnableTailscaleServe({ port }))
  }

  async #changeAppTailscale(serverId: string, change: (api: SolusAPI) => Promise<TailscaleServeStatus>): Promise<void> {
    if (this.appTailscaleBusyServerId !== null) return
    this.appTailscaleBusyServerId = serverId
    this.appTailscaleErrors.delete(serverId)
    try {
      this.appTailscale.set(serverId, await change(serverConnections.apiFor(serverId)))
      await this.loadAppEndpoint(serverId)
    } catch (e) {
      this.appTailscaleErrors.set(serverId, e instanceof Error ? e.message : String(e))
    } finally {
      this.appTailscaleBusyServerId = null
    }
  }

  #setAddressTest(serverId: string, source: AppAddressSource, test: AppAddressTestState): void {
    // A small record for each host, replaced whole: one test wakes only that host's readers.
    this.appAddressTests.set(serverId, { ...this.appAddressTests.get(serverId), [source]: test })
  }

  /** The pairing code shown for this host; null when it was made for another host. */
  appPairingCodeFor(serverId: string): AppPairingCode | null {
    return this.appPairingCodeServerId === serverId ? this.appPairingCode : null
  }

  appPairingCodeErrorFor(serverId: string): string | null {
    return this.appPairingCodeServerId === serverId ? this.appPairingCodeError : null
  }

  /** Makes a new one-time code for an outside app's sign-in page; it replaces the code shown, also another host's. */
  async createAppPairingCode(serverId: string, access: AppAccess): Promise<void> {
    if (this.appPairingCodeCreating) return
    this.appPairingCodeCreating = true
    if (this.appPairingCodeServerId !== serverId) {
      this.appPairingCodeServerId = serverId
      this.appPairingCode = null
    }
    this.appPairingCodeError = null
    try {
      const code = await serverConnections.apiFor(serverId).connectionsCreateAppPairingCode({ access })
      if (this.appPairingCodeServerId === serverId) this.appPairingCode = code
    } catch (e) {
      if (this.appPairingCodeServerId === serverId) this.appPairingCodeError = e instanceof Error ? e.message : String(e)
    } finally {
      this.appPairingCodeCreating = false
    }
  }

  async setRemoteAccess(serverId: string, remoteAccess: import('@solus/contracts/host-api').RemoteAccessMode): Promise<void> {
    if (!this.serverInfo || this.remoteAccessUpdating) return
    this.remoteAccessError = null
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
      this.remoteAccessError = e instanceof Error ? e.message : String(e)
      console.error('set remote access failed', e)
    } finally {
      this.remoteAccessUpdating = false
    }
  }

  async setTailscaleServe(serverId: string, enabled: boolean, port: number): Promise<void> {
    if (!this.serverInfo || this.tailscaleServeUpdating) return
    this.tailscaleServeUpdating = true
    this.tailscaleServeError = null
    try {
      const api = serverConnections.apiFor(serverId)
      const status = enabled
        ? await api.connectionsEnableTailscaleServe({ port })
        : await api.connectionsDisableTailscaleServe()
      if (this.metadataServerId === serverId && this.serverInfo) this.serverInfo.tailscaleServe = status
      await this.refreshServerMetadata(serverId)
    } catch (error) {
      this.tailscaleServeError = error instanceof Error ? error.message : String(error)
    } finally {
      this.tailscaleServeUpdating = false
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

  /** Revokes several devices or apps ("Revoke all apps"), then reads the list once. False when one revoke failed. */
  async revokeDevices(serverId: string, deviceIds: readonly string[]): Promise<boolean> {
    const api = serverConnections.apiFor(serverId)
    const results = await Promise.allSettled(deviceIds.map((deviceId) => api.connectionsRevokeDevice({ deviceId })))
    for (const result of results) if (result.status === 'rejected') console.error('revoke failed', result.reason)
    await this.refreshServerMetadata(serverId)
    return results.every((result) => result.status === 'fulfilled')
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

  /** Signs in to GitHub. True when the sign-in finished; false when one was
   *  already running or the person cancelled it. */
  async connectProvider(serverId: string, ctx: IpcContext): Promise<boolean> {
    if (this.providerConnecting) return false
    this.providerCancelling = false
    this.providerServerId = serverId
    this.providerConnecting = true
    try {
      const status = await serverConnections.apiFor(serverId).providerConnect($state.snapshot(ctx))
      if (this.providerServerId === serverId) {
        this.providerStatus = status
        this.providerLoaded = true
      }
      return true
    } catch (e) {
      if (this.providerCancelling) return false
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
