import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import { serverConnections } from '@solus/client-core/server-connections'
import type { SshTargetCandidate } from '@solus/contracts/remote-machines'
import { serversStore } from '../../contexts'
import { hosts } from '../../contexts/hosts/hosts.svelte'
import { forwardedHostsStore } from '../connections/forwarded-hosts.store.svelte'
import { addWslDistroStore } from '../servers/add-wsl-distro.store.svelte'
import { foundMachines, type FoundMachine } from './lib/discover'

/**
 * What this device can see but has not added (docs/plans/host-fleet.md D7): the
 * network scan (local network and tailnet), the WSL distros of this client's
 * Windows host, and the machines in the SSH config of the host that scans.
 */
class DiscoverStore {
  sshConfig = $state<SshTargetCandidate[]>([])
  /** When the last scan ended; null before the first. */
  lastScanAt = $state<number | null>(null)
  #isReadingSshConfig = $state(false)

  /** The host that looks: this computer on desktop, the host the page is served by on web, as the network scan does. */
  get scanningServerId(): string | null {
    return serversStore.local ? LOCAL_SERVER_ID : serverConnections.defaultServerId()
  }

  get isScanning(): boolean {
    return serversStore.discoveryBusy || this.#isReadingSshConfig
  }

  get found(): FoundMachine[] {
    const windowsHostId = addWslDistroStore.defaultWindowsHostId
    const scanningServerId = this.scanningServerId
    const forwardedTargets = scanningServerId ? (forwardedHostsStore.hostsFor(scanningServerId) ?? []).map((host) => host.sshTarget) : []
    return foundMachines({
      nearby: serversStore.nearbyHosts.map((host) => host.server),
      wsl: windowsHostId
        ? { windowsHostId, windowsHostName: serversStore.servers.find((server) => server.id === windowsHostId)?.label ?? 'this computer', distros: addWslDistroStore.addableDistros(windowsHostId) }
        : null,
      sshConfig: this.sshConfig,
      knownNames: new Set([...serversStore.servers.map((server) => server.label), ...forwardedTargets]),
    })
  }

  /** Looks again everywhere. The network scan also runs on its own every 30 s while a window has focus. */
  async scan(): Promise<void> {
    await Promise.all([serversStore.scanForServers(), this.readSshConfig()])
    this.lastScanAt = Date.now()
  }

  /** Keeps the WSL and forward lists read while a surface shows Discover. The result stops it. */
  watch(): () => void {
    const stops: Array<() => void> = []
    const windowsHostId = addWslDistroStore.defaultWindowsHostId
    if (windowsHostId) stops.push(addWslDistroStore.watch(windowsHostId))
    const scanningServerId = this.scanningServerId
    if (scanningServerId) stops.push(forwardedHostsStore.watch(scanningServerId))
    if (this.lastScanAt === null) void this.scan()
    return () => stops.forEach((stop) => stop())
  }

  /** Only the owner of the scanning host may read its SSH config; anyone else finds nothing there. */
  private async readSshConfig(): Promise<void> {
    const scanningServerId = this.scanningServerId
    const principal = scanningServerId ? hosts.get(scanningServerId).me.principal : undefined
    if (!scanningServerId || (principal !== undefined && principal !== 'local-owner' && principal !== 'remote-owner')) {
      this.sshConfig = []
      return
    }
    this.#isReadingSshConfig = true
    try {
      this.sshConfig = await serverConnections.apiFor(scanningServerId).hostsListSshConfigHosts()
    } catch {
      // An older host has no such call, and a refusal finds nothing: neither is an error to show.
      this.sshConfig = []
    } finally {
      this.#isReadingSshConfig = false
    }
  }
}

export const discoverStore = new DiscoverStore()
