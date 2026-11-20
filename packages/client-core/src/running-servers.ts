import { keepEqual } from './keep-equal'
import type { RunningServer, StopRunningServerResult, ServerEndpoint, NativeServerForward, NativeServerForwardRequest } from '@solus/contracts/running-servers'
import type { HostApi } from './host-api'
import type { HostEventSubscriber } from './host-event-subscriber'
import { serversForCheckout } from '@solus/contracts/running-servers'

type ServerApi = Pick<HostApi, 'runningServersWatch' | 'runningServersUnwatch' | 'runningServersCheckoutRoots' | 'runningServerStop' | 'runningServerTunnel' | 'projectConfigLoad' | 'projectConfigSave'>
export interface RunningServersView {
  status: 'loading' | 'ready' | 'disconnected' | 'error'
  servers: readonly RunningServer[]
  error: string | null
}
export const EMPTY_RUNNING_SERVERS: RunningServersView = { status: 'loading', servers: [], error: null }
export interface RunningServersSource {
  api: ServerApi
  events: HostEventSubscriber
  ready: boolean
}
export interface ServerForwarding {
  keyPrefix: string
  origin: () => string
  start: (request: NativeServerForwardRequest) => Promise<NativeServerForward>
  stop: (forwardId: string) => Promise<void>
  list: () => Promise<NativeServerForward[]>
  openExternal: (url: string) => Promise<boolean>
}

/** Shared by Svelte and React. Each host owns one instance, regardless of how
 *  many rows or panes read it. The server's lease is renewed while retained. */
export class RunningServers {
  private view: RunningServersView = EMPTY_RUNNING_SERVERS
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
  private readonly forwards = new Map<string, { serverId: string; endpoint: ServerEndpoint; view: NativeServerForward; release: () => void }>()
  private forwardVersion = 0
  private readonly forwardAttempts = new Map<string, Promise<NativeServerForward>>()
  private readonly forwardTokens = new Map<string, number>()
  private renewing = false
  private recoveredForwards = false

  constructor(
    private readonly sourceOf: () => RunningServersSource | null,
    private readonly observeConnection: (changed: () => void) => () => void,
    private readonly forwarding?: ServerForwarding,
  ) {}

  get current(): RunningServersView { return this.view }
  get forwarded(): readonly NativeServerForward[] { return [...this.forwards.values()].map((forward) => forward.view) }
  get canForward(): boolean { return !!this.forwarding }
  inCheckout(path: string | null): RunningServer[] {
    if (path && !this.checkoutRoots.has(path)) return []
    return serversForCheckout(this.view.servers, path, path ? this.checkoutRoots.get(path) ?? undefined : undefined)
  }
  private changed(): void { for (const listener of this.listeners) listener() }
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
      this.set(EMPTY_RUNNING_SERVERS)
    }
  }

  async stop(serverId: string): Promise<StopRunningServerResult> {
    const source = this.source
    if (!source?.ready) throw new Error('This host is disconnected.')
    const result = await source.api.runningServerStop(serverId)
    await this.refresh()
    return result
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

  async forward(server: RunningServer, endpoint: ServerEndpoint): Promise<NativeServerForward> {
    const endpointKey = `${this.forwarding?.keyPrefix}:${server.serverId}:${endpoint.endpointId}`
    const pending = this.forwardAttempts.get(endpointKey)
    if (pending) return pending
    const token = (this.forwardTokens.get(endpointKey) ?? 0) + 1
    this.forwardTokens.set(endpointKey, token)
    const attempt = this.startForward(server, endpoint, endpointKey, token)
    this.forwardAttempts.set(endpointKey, attempt)
    try { return await attempt } finally {
      this.forwardAttempts.delete(endpointKey)
      if (!this.forwards.has(endpointKey)) this.forwardTokens.delete(endpointKey)
    }
  }

  private async startForward(server: RunningServer, endpoint: ServerEndpoint, endpointKey: string, token: number): Promise<NativeServerForward> {
    const source = this.source
    if (!source?.ready || !this.forwarding) throw new Error('Port forwarding requires the desktop app and a connected host.')
    const version = this.forwardVersion
    const ticket = await source.api.runningServerTunnel(server.serverId, endpoint.endpointId)
    const tunnel = new URL(ticket.relativeUrl, this.forwarding.origin())
    tunnel.protocol = tunnel.protocol === 'https:' ? 'wss:' : 'ws:'
    const view = await this.forwarding.start({ endpointKey, tunnelUrl: tunnel.href, targetUrl: endpoint.url, expiresAt: ticket.expiresAt })
    if (version !== this.forwardVersion || source !== this.source || !this.source.ready || this.forwardTokens.get(endpointKey) !== token) {
      await this.forwarding.stop(view.forwardId)
      throw new Error('The host connection changed.')
    }
    const previous = this.forwards.get(endpointKey)
    const path = server.location.worktreePath ?? server.process.workingDirectory
    this.forwards.set(endpointKey, { serverId: server.serverId, endpoint, view, release: previous?.release ?? (path ? this.retainCheckout(path) : this.retain()) })
    if (!previous || previous.view.forwardId !== view.forwardId) this.changed()
    return view
  }

  async stopForward(forwardId: string): Promise<void> {
    for (const [key, forward] of this.forwards) if (forward.view.forwardId === forwardId) {
      this.forwardTokens.set(key, (this.forwardTokens.get(key) ?? 0) + 1)
      this.forwards.delete(key)
      forward.release()
      this.changed()
      await this.forwarding?.stop(forwardId)
      if (!this.forwardAttempts.has(key)) this.forwardTokens.delete(key)
    }
  }

  async openExternal(server: RunningServer, endpoint: ServerEndpoint): Promise<void> {
    if (!this.forwarding) throw new Error('Open this server in the host browser, or use the desktop app to forward its port.')
    const forwarded = await this.forward(server, endpoint)
    if (!await this.forwarding.openExternal(forwarded.url)) throw new Error('Cannot open the system browser.')
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
    if (!source?.ready) {
      this.forwardVersion++
      for (const forward of this.forwards.values()) { void this.forwarding?.stop(forward.view.forwardId).catch(() => {}); forward.release() }
      this.forwards.clear()
      this.changed()
    }
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

  private set(view: RunningServersView): void {
    const next = keepEqual(view, this.view)
    if (next === this.view) return
    this.view = next
    this.changed()
  }

  private async renewForwards(): Promise<void> {
    if (this.renewing || !this.forwarding) return
    this.renewing = true
    try {
      for (const forward of this.forwards.values()) {
        const server = this.view.servers.find((candidate) => candidate.serverId === forward.serverId)
        const endpoint = server?.endpoints.find((candidate) => candidate.endpointId === forward.endpoint.endpointId)
        try {
          if (!server || !endpoint) await this.stopForward(forward.view.forwardId)
          else await this.forward(server, endpoint)
        } catch { await this.stopForward(forward.view.forwardId).catch(() => {}) }
      }
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
        if (!forward.endpointKey.startsWith(`${this.forwarding.keyPrefix}:`)) continue
        const server = this.view.servers.find((candidate) => candidate.endpoints.some((endpoint) => forward.endpointKey === `${forwarding.keyPrefix}:${candidate.serverId}:${endpoint.endpointId}`))
        const endpoint = server?.endpoints.find((candidate) => forward.endpointKey === `${forwarding.keyPrefix}:${server.serverId}:${candidate.endpointId}`)
        if (server && endpoint) await this.forward(server, endpoint)
        else await this.forwarding.stop(forward.forwardId)
      }
    } catch { /* Unrenewed native ports expire with their last ticket. */ }
  }
}
