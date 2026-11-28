import { SvelteMap } from 'svelte/reactivity'
import type { HostDiskSpace } from '@solus/contracts/host-resources'
import { serverConnections } from '@solus/client-core/server-connections'
import { hostReadinessCopy } from '@solus/client-core/host-readiness'
import { serversStore, type ServerItem } from '../../contexts'
import { hosts } from '../../contexts/hosts/hosts.svelte'
import { hostUpdatesStore } from '../../contexts/updates/host-updates.store.svelte'
import { hostUpdater } from '../../contexts/updates/host-updater.svelte'
import { isCloudHost } from '../servers/lib/managed-host'
import { fleetMachine, type FleetMachine, type FleetZoneId, type Traffic, type ZoneAnswers } from './lib/fleet-model'

/** Machine load moves slowly, and a host caches it for 5 s. */
const LOAD_REFRESH_MS = 5_000
/** Reads at once, so a large fleet does not ask every host in the same instant. */
const LOAD_CONCURRENCY = 4
/** The CPU history a host page draws: 40 reads, a little over 3 minutes. */
const HISTORY_POINTS = 40

export interface HostLoad {
  /** 0 to 100. */
  cpu: number | null
  memory: number | null
  /** The round trip of the last `hostResources()` call: the latency the map shows. */
  latencyMs: number | null
  cpuCount: number | null
  totalMemoryBytes: number | null
  /** The disk of the host's Solus data folder. Null when the host could not read it, or is too old to say. */
  disk: HostDiskSpace | null
  cpuHistory: number[]
  /** KB/s each way on this device's connection to the host, between the last two reads; null until there are two. */
  traffic: Traffic | null
}

/**
 * Every host as a `FleetMachine`, and the load of the hosts a surface holds.
 * A host is asked for its load only while the map or
 * its page holds it: a fleet nobody looks at costs nothing. The load comes from
 * `hostResources()` alone, not the process telemetry, so a large fleet stays cheap.
 */
class FleetStore {
  readonly loads = new SvelteMap<string, HostLoad>()
  readonly #holders = new Map<string, number>()
  /** The byte counts of each host's connection at its last read, to take a rate from the next. */
  readonly #trafficReads = new Map<string, { at: number; in: number; out: number }>()
  #timer: ReturnType<typeof setInterval> | null = null
  #isReading = false

  /** The fleet now. `busyByHost` is the count of working sessions on each host, which only a workspace knows. */
  machines(busyByHost: ReadonlyMap<string, number>): FleetMachine[] {
    const organizationNames = new Map(serversStore.organizations.map((organization) => [organization.organizationId, organization.name]))
    return serversStore.servers.map((server) => this.machineOf(server, busyByHost.get(server.id) ?? 0, organizationNames))
  }

  machineOf(server: ServerItem, sessions: number, organizationNames: ReadonlyMap<string, string> = new Map()): FleetMachine {
    const load = this.loads.get(server.id)
    const organizationId = server.uplink?.organizationIds?.[0]
    return fleetMachine({
      serverId: server.id,
      installationId: server.installationId,
      label: server.label,
      os: server.os,
      isThisDevice: server.local,
      isCloud: isCloudHost(server.uplink),
      hasManagedCompute: server.uplink?.hasManagedCompute === true,
      principal: hosts.get(server.id).me.principal,
      ownerName: server.uplink?.ownerName,
      organizationName: organizationId ? organizationNames.get(organizationId) : undefined,
      readiness: server.readiness,
      readinessCopy: hostReadinessCopy(serversStore.readinessFor(server.id), server.label),
      managedState: server.uplink?.managedState,
      routeKind: server.local ? null : routeKindInUse(server),
      dialedRouteKind: server.local ? undefined : dialedRouteKind(server),
      address: server.local ? undefined : server.url,
      sessions,
      load: load ? { cpu: load.cpu, memory: load.memory, latencyMs: load.latencyMs, traffic: load.traffic } : null,
      hasUpdate: hostUpdatesStore.pendingCountFor(server.id) > 0,
    })
  }

  /** Read the load of these hosts until the result is called. Holds count, so two surfaces may hold one host. */
  hold(serverIds: readonly string[]): () => void {
    for (const serverId of serverIds) this.#holders.set(serverId, (this.#holders.get(serverId) ?? 0) + 1)
    if (!this.#timer && this.#holders.size > 0) {
      this.#timer = setInterval(() => void this.readLoads(), LOAD_REFRESH_MS)
      void this.readLoads()
    }
    return () => {
      for (const serverId of serverIds) {
        const count = (this.#holders.get(serverId) ?? 0) - 1
        if (count > 0) this.#holders.set(serverId, count)
        else this.#holders.delete(serverId)
      }
      if (this.#holders.size === 0 && this.#timer) {
        clearInterval(this.#timer)
        this.#timer = null
      }
    }
  }

  /** Installs every update these hosts have, Solus and agent CLIs alike, as "Update all" does. */
  updateHosts(serverIds: readonly string[]): void {
    const updates = serverIds.flatMap((serverId) => hostUpdatesStore.installableUpdatesFor(serverId))
    if (updates.length && !hostUpdater.isRunning) void hostUpdater.update(updates)
  }

  /** Whether each zone's hosts are read yet: yours from the host list, the rest from the account directory (plans/033 §3 Q2). */
  get answers(): ZoneAnswers {
    return { own: serversStore.listState, cloud: serversStore.directoryState, shared: serversStore.directoryState }
  }

  /** Reads a zone's hosts again after its read failed. */
  retryZone(zone: FleetZoneId): void {
    serversStore.retryHosts(zone === 'own' ? 'list' : 'directory')
  }

  /** Dials these hosts again now. */
  retryHosts(serverIds: readonly string[]): void {
    for (const serverId of serverIds) serversStore.retry(serverId)
  }

  /** Starts the stopped managed compute of these cloud machines. */
  startHosts(serverIds: readonly string[]): void {
    for (const serverId of serverIds) void serversStore.startManagedHost(serverId)
  }

  private async readLoads(): Promise<void> {
    if (this.#isReading) return
    this.#isReading = true
    try {
      // Only a host that answers now is asked; the others show their state, not a stale number.
      const ready = new Set(serversStore.servers.filter((server) => server.readiness === 'ready').map((server) => server.id))
      const serverIds = [...this.#holders.keys()].filter((serverId) => ready.has(serverId))
      let next = 0
      const reader = async () => {
        while (next < serverIds.length) await this.readLoad(serverIds[next++]!)
      }
      await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, serverIds.length) }, reader))
    } finally {
      this.#isReading = false
    }
  }

  /**
   * KB/s each way on this device's connection to the host since the last read,
   * from the byte counts of its transport. A new connection counts from zero, so
   * a count that went down starts a new rate.
   */
  private readTraffic(serverId: string): Traffic | null {
    const counted = serverConnections.connectionFor(serverId)?.transport.traffic
    if (!counted) return null
    const at = performance.now()
    const last = this.#trafficReads.get(serverId)
    this.#trafficReads.set(serverId, { at, ...counted })
    if (!last || counted.in < last.in || counted.out < last.out || at <= last.at) return null
    const seconds = (at - last.at) / 1000
    const rate = (bytes: number) => Math.round((bytes / 1024 / seconds) * 10) / 10
    return { down: rate(counted.in - last.in), up: rate(counted.out - last.out) }
  }

  private async readLoad(serverId: string): Promise<void> {
    const startedAt = performance.now()
    try {
      const resources = await serverConnections.apiFor(serverId).hostResources()
      if (!this.#holders.has(serverId)) return
      const cpu = resources.cpuUtilization === null ? null : Math.round(resources.cpuUtilization * 100)
      const memory = resources.totalMemoryBytes > 0
        ? Math.round((1 - resources.availableMemoryBytes / resources.totalMemoryBytes) * 100)
        : null
      const history = this.loads.get(serverId)?.cpuHistory ?? []
      this.loads.set(serverId, {
        cpu,
        memory,
        latencyMs: Math.round(performance.now() - startedAt),
        cpuCount: resources.cpuCount,
        totalMemoryBytes: resources.totalMemoryBytes,
        disk: resources.disk ?? null,
        cpuHistory: cpu === null ? history : [...history, cpu].slice(-HISTORY_POINTS),
        traffic: this.readTraffic(serverId),
      })
    } catch {
      // A dropped host shows its readiness; its last load stays until it answers again.
    }
  }
}

/** The kind of the route this client dials the host on now; its first route when none is dialed. */
function routeKindInUse(server: ServerItem) {
  return dialedRouteKind(server) ?? server.routes[0]?.kind ?? null
}

/** The kind of the route this client dials the host on now; undefined when it dials none. */
function dialedRouteKind(server: ServerItem) {
  const dialed = serverConnections.dialedUrl(server.id)
  return dialed ? server.routes.find((route) => route.url === dialed)?.kind : undefined
}

export const fleetStore = new FleetStore()
