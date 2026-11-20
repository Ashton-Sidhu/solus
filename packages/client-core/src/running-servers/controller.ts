import { keepEqual, sameItems } from '../keep-equal'
import type { RunningServer } from '@solus/contracts/running-servers'
import type { HostApi } from '../host-api'
import type { HostEventSubscriber } from '../host-event-subscriber'
import { RunningServers, type RunningServersForwarding, type RunningServersRow, type RunningServersCommands } from './running-servers'

type ServerApi = Pick<HostApi, 'runningServersWatch' | 'runningServersUnwatch' | 'runningServersCheckoutRoots' | 'runningServerStop' | 'runningServerTunnel' | 'projectConfigLoad' | 'projectConfigSave'>
interface StoreState {
  status: 'loading' | 'ready' | 'disconnected' | 'error'
  servers: readonly RunningServer[]
  error: string | null
}
export interface RunningServersSource {
  api: ServerApi
  events: HostEventSubscriber
  ready: boolean
}
export interface RunningServersStoreState {
  status: StoreState['status']
  error: string | null
  servers: readonly RunningServers[]
  revision: number
}
export interface RunningServersBinding {
  state: RunningServersStoreState
  createServer: (data: RunningServer, commands: RunningServersCommands) => RunningServers
}

/** Shared by Svelte and React. Each host owns one instance, regardless of how
 *  many rows or panes read it. The server's lease is renewed while retained. */
export class RunningServersController {
  private static readonly empty: StoreState = { status: 'loading', servers: [], error: null }
  private view: StoreState = RunningServersController.empty
  private readonly state: RunningServersStoreState
  private readonly createServer: RunningServersBinding['createServer']
  private readonly listeners = new Set<() => void>()
  private holders = 0
  private epoch = 0
  private eventVersion = 0
  private inFlight = false
  private timer: ReturnType<typeof setInterval> | null = null
  private stopConnection: (() => void) | null = null
  private stopEvents: (() => void) | null = null
  private source: RunningServersSource | null = null
  private readonly checkoutPaths = new Map<string, number>()
  private readonly checkoutRoots = new Map<string, string | null>()
  private refreshPending = false
  private readonly models = new Map<string, RunningServers>()
  private renewing = false
  private recoveredForwards = false

  constructor(
    private readonly sourceOf: () => RunningServersSource | null,
    private readonly observeConnection: (changed: () => void) => () => void,
    private readonly forwarding?: RunningServersForwarding,
    binding?: RunningServersBinding,
  ) {
    this.state = binding?.state ?? { status: 'loading', error: null, servers: [], revision: 0 }
    this.createServer = binding?.createServer ?? ((data, commands) => new RunningServers(data, commands))
  }

  get revision(): number { return this.state.revision }
  get status() { return this.state.status }
  get error() { return this.state.error }
  get servers(): readonly RunningServers[] { return this.state.servers }
  inCheckout(path: string | null): RunningServers[] {
    void this.state.revision
    if (path && !this.checkoutRoots.has(path)) return []
    return this.servers.filter((server) => server.matchesCheckout(path, path ? this.checkoutRoots.get(path) ?? undefined : undefined))
  }
  rows(path?: string | null): RunningServersRow[] {
    const groups = new Map<string | null, RunningServersRow[]>()
    for (const server of path === undefined ? this.servers : this.inCheckout(path)) {
      const rows = groups.get(server.checkoutPath) ?? []
      rows.push(...server.rows)
      groups.set(server.checkoutPath, rows)
    }
    return [...groups.values()].flat()
  }
  private changed(): void { this.state.revision++; for (const listener of this.listeners) listener() }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  retain(): () => void {
    if (this.holders++ === 0) {
      this.stopConnection = this.observeConnection(() => this.connect())
      this.timer = setInterval(() => void this.refresh(), 8000)
      this.connect()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.holders) return
      this.epoch++
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.stopConnection?.()
      this.stopConnection = null
      this.stopEvents?.()
      this.stopEvents = null
      const source = this.source
      this.source = null
      this.inFlight = false
      if (source?.ready) void source.api.runningServersUnwatch().catch(() => {})
      this.set(RunningServersController.empty)
    }
  }

  retainCheckout(path: string | null): () => void {
    if (!path) return this.retain()
    this.checkoutPaths.set(path, (this.checkoutPaths.get(path) ?? 0) + 1)
    const release = this.retain()
    void this.refresh()
    return () => {
      const count = this.checkoutPaths.get(path) ?? 0
      if (count > 1) this.checkoutPaths.set(path, count - 1)
      else this.checkoutPaths.delete(path)
      if (count <= 1) this.checkoutRoots.delete(path)
      release()
      void this.refresh()
    }
  }

  async configuredUrls(path: string): Promise<string[]> {
    const source = this.sourceOf()
    if (!source?.ready) throw new Error('This host is disconnected.')
    return (await source.api.projectConfigLoad(path))?.serverUrls ?? []
  }

  async configureUrls(path: string, urls: string[]): Promise<void> {
    const source = this.sourceOf()
    if (!source?.ready) throw new Error('This host is disconnected.')
    const config = await source.api.projectConfigLoad(path)
    await source.api.projectConfigSave(path, { ...config, version: 1, serverUrls: urls })
    await this.refresh()
  }

  retry(): void { void this.refresh() }

  private connect(): void {
    if (!this.holders) return
    const source = this.sourceOf()
    if (this.source && source?.api === this.source.api && source?.events === this.source?.events && source?.ready === this.source?.ready) return
    this.epoch++
    this.inFlight = false
    this.stopEvents?.()
    this.stopEvents = null
    this.source = source
    this.recoveredForwards = false
    this.checkoutRoots.clear()
    this.set({ status: source?.ready ? 'loading' : 'disconnected', servers: [], error: null })
    if (!source?.ready) return
    this.stopEvents = source.events.subscribe('runningServers.changed', ({ servers, error }) => {
      this.eventVersion++
      this.set({ status: error ? 'error' : 'ready', servers: error ? [] : servers, error })
      void this.renewForwards()
    })
    void this.refresh()
  }

  private async refresh(): Promise<void> {
    if (!this.holders || !this.source?.ready) return
    if (this.inFlight) { this.refreshPending = true; return }
    const epoch = this.epoch
    const eventVersion = this.eventVersion
    const source = this.source
    this.inFlight = true
    try {
      const paths = [...this.checkoutPaths.keys()]
      const missing = paths.filter((path) => !this.checkoutRoots.has(path))
      const [servers, roots] = await Promise.all([
        source.api.runningServersWatch(paths),
        missing.length ? source.api.runningServersCheckoutRoots(missing) : Promise.resolve([]),
      ])
      if (epoch !== this.epoch) {
        if (!this.holders) void source.api.runningServersUnwatch().catch(() => {})
        return
      }
      // An event delivered during the RPC is newer than its initial list.
      for (const { path, root } of roots) if (this.checkoutPaths.has(path)) this.checkoutRoots.set(path, root)
      if (eventVersion === this.eventVersion) this.set({ status: 'ready', servers, error: null })
      if (roots.length) { this.view = { ...this.view }; this.changed() }
      if (this.recoveredForwards) void this.renewForwards()
      else void this.recoverForwards(epoch)
    } catch (error) {
      if (epoch === this.epoch && eventVersion === this.eventVersion) this.set({ status: 'error', servers: [], error: error instanceof Error ? error.message : 'Cannot read running servers.' })
    } finally {
      if (epoch === this.epoch) {
        this.inFlight = false
        if (this.refreshPending) { this.refreshPending = false; void this.refresh() }
      }
    }
  }

  private set(view: StoreState): void {
    const next = keepEqual(view, this.view)
    if (next === this.view) return
    for (const [serverId, model] of this.models) if (!view.servers.some((server) => server.serverId === serverId)) {
      this.models.delete(serverId)
      model.dispose()
    }
    for (const data of view.servers) {
      const model = this.models.get(data.serverId)
      if (model) model.update(data)
      else this.models.set(data.serverId, this.createServer(data, {
        source: () => this.source, forwarding: this.forwarding,
        retain: (path) => this.retainCheckout(path), refresh: () => this.refresh(),
        changed: () => { this.view = { ...this.view }; this.changed() },
      }))
    }
    const items = view.servers.map((data) => this.models.get(data.serverId)!)
    if (!sameItems(items, this.state.servers)) this.state.servers = items
    this.state.status = next.status
    this.state.error = next.error
    this.view = next
    this.changed()
  }

  private async renewForwards(): Promise<void> {
    if (this.renewing || !this.forwarding) return
    this.renewing = true
    try {
      for (const server of this.servers) await server.renewForwards()
    } finally { this.renewing = false }
  }

  private async recoverForwards(epoch: number): Promise<void> {
    this.recoveredForwards = true
    const forwarding = this.forwarding
    if (!forwarding) return
    try {
      const held = await forwarding.list()
      if (epoch !== this.epoch) return
      for (const forward of held) {
        if (!forward.endpointKey.startsWith(`${forwarding.keyPrefix}:`)) continue
        let restored = false
        for (const server of this.servers) if (await server.restoreForward(forward)) { restored = true; break }
        if (!restored) await forwarding.stop(forward.forwardId)
      }
    } catch { /* Unrenewed native ports expire with their last ticket. */ }
  }
}
