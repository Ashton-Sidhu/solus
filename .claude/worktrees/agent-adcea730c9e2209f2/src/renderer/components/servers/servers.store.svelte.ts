import type { ConnectionStatus } from '@client-core/ws-transport'
import { connectionState, subscribe } from '@client-core/connection-state'
import type { LocalConnectionInfoLike, SolusServerTarget } from '@client-core/server-connection'
import { SvelteSet } from 'svelte/reactivity'
import {
  getActiveServerId,
  loadServers,
  LOCAL_SERVER_ID,
  removeServer,
  setActiveServerId,
  touchLastConnected,
  upsertServer,
  type SavedServer,
} from '@client-core/server-registry'
import type { DiscoveredServer } from '../../../shared/types'
import { requestInputFocus } from '../../lib/inputFocus'
import { toasts } from '../../contexts/toast.store.svelte'
import { discoveredServerUrl, filterNewDiscoveredServers } from './discovery'

export type ServerItemStatus = 'online' | 'connecting' | 'offline' | 'saved'

const DISCOVERY_INTERVAL_MS = 30_000
export interface ServerItem {
  id: string
  label: string
  url: string
  installationId?: string
  local: boolean
  status: ServerItemStatus
}

class ServersStore {
  local = $state<LocalConnectionInfoLike | null>(null)
  remotes = $state<SavedServer[]>(loadServers())
  activeServerId = $state(connectionState.target?.id ?? getActiveServerId())
  connectionStatus = $state<ConnectionStatus>(connectionState.status)
  reconnectAttempt = $state(connectionState.attempt)
  hasConnected = $state(connectionState.status === 'connected')
  addServerOpen = $state(false)
  addServerUrl = $state('')
  claimServerOpen = $state(false)
  claimTarget = $state<DiscoveredServer | null>(null)
  discoveryBusy = $state(false)
  discovered = $state<DiscoveredServer[]>([])
  readonly dismissedDiscovered = new SvelteSet<string>()

  private initialized = false
  private discoveryTimer: ReturnType<typeof setInterval> | null = null
  private scanInFlight = false

  get servers(): ServerItem[] {
    const local = this.local
      ? [{
          id: LOCAL_SERVER_ID,
          label: 'This Mac',
          url: `http://127.0.0.1:${this.local.port}`,
          installationId: this.local.installationId,
          local: true,
          status: this.statusFor(LOCAL_SERVER_ID),
        } satisfies ServerItem]
      : []
    return [
      ...local,
      ...this.remotes.map((server) => ({
        id: server.id,
        label: server.label,
        url: server.url,
        installationId: server.installationId,
        local: false,
        status: this.statusFor(server.id),
      })),
    ]
  }

  get activeServer(): ServerItem | null {
    return this.servers.find((server) => server.id === this.activeServerId) ?? this.servers[0] ?? null
  }

  get activeTarget(): SolusServerTarget | null {
    return connectionState.target ?? null
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true

    const updateAutoDiscovery = () => this.updateAutoDiscovery()
    window.addEventListener('focus', updateAutoDiscovery)
    window.addEventListener('blur', updateAutoDiscovery)
    document.addEventListener('visibilitychange', updateAutoDiscovery)
    updateAutoDiscovery()

    void window.solusNative.getLocalConnection().then((local) => {
      this.local = local
      this.updateAutoDiscovery()
    })

    subscribe(({ status, attempt, target }) => {
      if (target) this.activeServerId = target.id
      this.connectionStatus = status
      this.reconnectAttempt = attempt
      if (status === 'connected') this.hasConnected = true
      this.updateAutoDiscovery()
    })
  }

  refreshServers(): void {
    this.remotes = loadServers()
  }

  savePairedServer(server: SavedServer): void {
    upsertServer(server)
    this.refreshServers()
  }

  openAddServer(prefillUrl = ''): void {
    this.addServerUrl = prefillUrl
    this.addServerOpen = true
  }

  closeAddServer(): void {
    this.addServerOpen = false
    this.addServerUrl = ''
    requestInputFocus()
  }

  openClaimServer(server: DiscoveredServer): void {
    this.claimTarget = server
    this.claimServerOpen = true
  }

  closeClaimServer(): void {
    this.claimServerOpen = false
    this.claimTarget = null
    requestInputFocus()
  }

  async scanForServers(opts: { manual?: boolean } = {}): Promise<void> {
    const manual = opts.manual === true
    if (this.scanInFlight) return
    this.scanInFlight = true
    this.discoveryBusy = true
    try {
      const discovered = await window.solus.discoverServers()
      const filtered = filterNewDiscoveredServers({
        discovered,
        savedServers: loadServers(),
        dismissedInstallationIds: this.dismissedDiscovered,
        selfInstallationId: this.local?.installationId,
      })
      this.discovered = filtered
      if (filtered.length === 0) {
        if (manual) toasts.info('No new Solus servers found')
        return
      }
      this.showDiscoveryToast(filtered[0])
    } catch (err) {
      if (manual) toasts.error(`Server scan failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.discoveryBusy = false
      this.scanInFlight = false
    }
  }

  switchTo(serverId: string): void {
    if (serverId === this.activeServerId) {
      requestInputFocus()
      return
    }
    setActiveServerId(serverId)
    if (serverId !== LOCAL_SERVER_ID) touchLastConnected(serverId)
    requestInputFocus()
    location.reload()
  }

  remove(serverId: string): void {
    if (serverId === LOCAL_SERVER_ID) return
    removeServer(serverId)
    this.refreshServers()
    requestInputFocus()
    if (serverId === this.activeServerId) location.reload()
  }

  retryActive(): void {
    location.reload()
  }

  private statusFor(serverId: string): ServerItemStatus {
    if (serverId !== this.activeServerId) return 'saved'
    if (this.connectionStatus === 'connected') return 'online'
    if (this.connectionStatus === 'connecting' || this.connectionStatus === 'reconnecting') return 'connecting'
    return 'offline'
  }

  private updateAutoDiscovery(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer)
      this.discoveryTimer = null
    }
    if (!this.shouldAutoDiscover()) return
    void this.scanForServers()
    this.discoveryTimer = setInterval(() => {
      if (!this.shouldAutoDiscover()) {
        this.updateAutoDiscovery()
        return
      }
      void this.scanForServers()
    }, DISCOVERY_INTERVAL_MS)
  }

  private shouldAutoDiscover(): boolean {
    if (document.hidden || !document.hasFocus()) return false
    if (this.activeServerId !== LOCAL_SERVER_ID) return false
    if (!this.activeTarget?.local) return false
    return window.solus.getPlatform?.() !== 'web'
  }

  private showDiscoveryToast(server: DiscoveredServer): void {
    toasts.info(`New Solus server found: ${server.name}`, {
      duration: 12_000,
      action: {
        label: server.claimable ? 'Claim' : 'Pair',
        onAction: () => {
          if (server.claimable) this.openClaimServer(server)
          else this.openAddServer(discoveredServerUrl(server))
        },
      },
      onDismiss: () => {
        this.dismissedDiscovered.add(server.installationId)
      },
    })
  }
}

export const serversStore = new ServersStore()
