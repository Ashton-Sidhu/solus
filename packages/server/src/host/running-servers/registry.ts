import type { RunningServer, StopRunningServerResult } from '@solus/contracts/running-servers'
import { ServerDiscovery } from './discovery'

const REFRESH_MS = 3000
const LEASE_MS = 20_000

/** One finished scan, for a reader on the host that follows the registry's refresh (mcp-first-class.md §9). */
export type RunningServerScan = { at: number; servers: RunningServer[]; listeningPorts: ReadonlySet<number> } | { at: number; error: string }

export interface RunningServerRegistryDeps {
  discovery: Pick<ServerDiscovery, 'discover' | 'identityMatches' | 'stopJob' | 'checkoutRoots'> & Partial<Pick<ServerDiscovery, 'listeningPorts'>>
  publish: (clientIds: string[], servers: RunningServer[], error: string | null) => void
  now: () => number
  schedule: (tick: () => Promise<void>, delayMs: number) => () => void
}

/** One bounded scan for all clients. A disconnected client loses its lease. */
export class RunningServerRegistry {
  private readonly subscribers = new Map<string, { at: number; paths: string[] }>()
  private servers: RunningServer[] = []
  private signature = ''
  private inFlight: Promise<RunningServer[]> | null = null
  private timer: (() => void) | null = null
  private scannedAt = -Infinity
  private generation = 0
  private readonly scanObservers = new Set<(scan: RunningServerScan) => void>()

  constructor(private readonly deps: RunningServerRegistryDeps) {}

  async list(force = false): Promise<RunningServer[]> {
    if (this.inFlight) return this.inFlight
    if (!force && this.deps.now() - this.scannedAt < REFRESH_MS) return this.servers
    const generation = this.generation
    this.inFlight = this.deps.discovery.discover([...new Set([...this.subscribers.values()].flatMap((lease) => lease.paths))]).then((servers) => {
      if (generation !== this.generation) return servers
      this.scannedAt = this.deps.now()
      this.servers = servers
      this.observed({ at: this.scannedAt, servers, listeningPorts: this.deps.discovery.listeningPorts?.() ?? new Set(servers.flatMap((server) => server.endpoints.map((endpoint) => endpoint.port))) })
      const signature = JSON.stringify(servers)
      if (signature !== this.signature) {
        this.signature = signature
        this.deps.publish([...this.subscribers.keys()], servers, null)
      }
      return servers
    }).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  async watch(clientId: string, paths: string[] = []): Promise<RunningServer[]> {
    const changed = JSON.stringify(this.subscribers.get(clientId)?.paths ?? []) !== JSON.stringify(paths)
    this.subscribers.set(clientId, { at: this.deps.now(), paths })
    if (changed && this.inFlight) await this.inFlight
    try { return await this.list(changed) } finally { this.schedule() }
  }

  unwatch(clientId: string): void {
    this.subscribers.delete(clientId)
    if (!this.subscribers.size && this.timer) {
      this.timer()
      this.timer = null
    }
  }

  stop(): void {
    this.generation++
    this.subscribers.clear()
    if (this.timer) this.timer()
    this.timer = null
  }

  async stopServer(serverId: string): Promise<StopRunningServerResult> {
    // The client sends an opaque id, never a PID it wants us to kill.
    const selected = this.servers.find((server) => server.serverId === serverId)
    if (!selected) return { status: 'already-exited' }
    if (!selected.actions.canStop) return { status: 'refused', reason: 'not-permitted' }
    const current = await this.list(true)
    const server = current.find((candidate) => candidate.serverId === serverId)
    if (!server) return current.some((candidate) => candidate.process.pid === selected.process.pid)
      ? { status: 'refused', reason: 'identity-changed' }
      : { status: 'already-exited' }
    if (!server.actions.canStop || !await this.deps.discovery.identityMatches(server)) return { status: 'refused', reason: 'identity-changed' }
    const result = await this.deps.discovery.stopJob(server)
    this.scannedAt = -Infinity
    await this.list(true)
    return result
  }

  /** Each scan, and each failed scan, as it ends. It starts none: a reader follows the clients' leases. */
  observeScans(observer: (scan: RunningServerScan) => void): () => void {
    this.scanObservers.add(observer)
    return () => { this.scanObservers.delete(observer) }
  }

  private observed(scan: RunningServerScan): void {
    for (const observer of this.scanObservers) observer(scan)
  }

  checkoutRoots(paths: string[]) { return this.deps.discovery.checkoutRoots(paths) }

  identityMatches(server: RunningServer): Promise<boolean> { return this.deps.discovery.identityMatches(server) }

  private schedule(): void {
    if (this.timer || !this.subscribers.size) return
    this.timer = this.deps.schedule(async () => {
      this.timer = null
      await this.tick()
    }, REFRESH_MS)
  }

  private async tick(): Promise<void> {
    for (const [clientId, lease] of this.subscribers) if (this.deps.now() - lease.at >= LEASE_MS) this.subscribers.delete(clientId)
    if (!this.subscribers.size) return
    try { await this.list(true) } catch (error) {
      this.signature = ''
      this.observed({ at: this.deps.now(), error: error instanceof Error ? error.message : 'Cannot scan running servers.' })
      this.deps.publish([...this.subscribers.keys()], [], error instanceof Error ? error.message : 'Cannot scan running servers.')
    } finally { this.schedule() }
  }
}

let registry: RunningServerRegistry | null = null
export function initRunningServers(publish: RunningServerRegistryDeps['publish'], runAsHost: <Result>(operation: () => Promise<Result>) => Promise<Result>): RunningServerRegistry {
  registry?.stop()
  const discovery = new ServerDiscovery()
  registry = new RunningServerRegistry({
    // Scans and tunnel upgrades are host work, including calls outside an RPC's actor scope.
    discovery: {
      discover: (paths) => runAsHost(() => discovery.discover(paths)),
      checkoutRoots: (paths) => runAsHost(() => discovery.checkoutRoots(paths)),
      listeningPorts: () => discovery.listeningPorts(),
      identityMatches: (server) => runAsHost(() => discovery.identityMatches(server)),
      stopJob: (server) => runAsHost(() => discovery.stopJob(server)),
    }, publish,
    now: Date.now,
    schedule: (tick, delayMs) => {
      const timer = setTimeout(() => void tick(), delayMs)
      timer.unref()
      return () => clearTimeout(timer)
    },
  })
  return registry
}
export function runningServers(): RunningServerRegistry {
  if (!registry) throw new Error('Running server discovery is not initialized')
  return registry
}
