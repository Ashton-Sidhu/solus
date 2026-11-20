import { keepEqual } from '../keep-equal'
import type { RunningServer, ServerEndpoint, NativeServerForward, NativeServerForwardRequest } from '@solus/contracts/running-servers'
import { isInsideHostPath, sameHostPath } from '@solus/contracts/host-path'
import type { RunningServersSource } from './controller'

export interface RunningServersForwarding {
  keyPrefix: string
  origin: () => string
  start: (request: NativeServerForwardRequest) => Promise<NativeServerForward>
  stop: (forwardId: string) => Promise<void>
  list: () => Promise<NativeServerForward[]>
  openExternal: (url: string) => Promise<boolean>
}
export interface RunningServersCommands {
  source: () => RunningServersSource | null
  forwarding?: RunningServersForwarding
  retain: (path: string | null) => () => void
  refresh: () => Promise<void>
  changed: () => void
}
export interface RunningServersRow { server: RunningServers; endpoint: ServerEndpoint; checkoutPath: string | null; label: string }

export interface RunningServersState { data: RunningServer; revision: number }

/** One discovered process. Its commands and forwarded ports live and end with this identity. */
export class RunningServers {
  #present = true
  #generation = 0
  readonly #forwards = new Map<string, { view: NativeServerForward; release: () => void }>()
  readonly #attempts = new Map<string, Promise<NativeServerForward>>()
  readonly #tokens = new Map<string, number>()

  constructor(data: RunningServer, private readonly commands: RunningServersCommands, private readonly state: RunningServersState = { data, revision: 0 }) {}
  get serverId() { return this.state.data.serverId }
  get process() { return this.state.data.process }
  get location() { return this.state.data.location }
  get startedBy() { return this.state.data.startedBy }
  get actions() { return this.state.data.actions }
  get endpoints() { return this.state.data.endpoints }
  get checkoutPath() { return this.location.worktreePath ?? this.process.workingDirectory }
  get sourceLabel() { return this.startedBy.kind === 'agent' ? 'Agent' : this.startedBy.kind === 'terminal' ? 'Terminal' : 'Configured' }
  get canForward() { return !!this.commands.forwarding }
  get forwards() { void this.state.revision; return [...this.#forwards.values()].map((forward) => forward.view) }
  get rows(): RunningServersRow[] { return this.endpoints.map((endpoint) => ({ server: this, endpoint, checkoutPath: this.checkoutPath, label: this.endpointLabel(endpoint) })) }
  update(data: RunningServer): void {
    if (data.serverId !== this.serverId) throw new Error('A server cannot change its process identity.')
    this.state.data = keepEqual(data, this.state.data)
  }
  matchesCheckout(path: string | null, root?: string): boolean {
    if (!path) return this.location.worktreePath === null
    const directory = this.checkoutPath
    if (!directory) return false
    if (root) return sameHostPath(directory, root)
    return isInsideHostPath(directory, path) || (!this.location.worktreePath && isInsideHostPath(path, directory))
  }
  endpointLabel(endpoint: ServerEndpoint): string {
    const type = endpoint.response?.contentType?.split(';')[0] ?? ''
    const format = type.includes('json') ? 'JSON' : type.includes('html') ? 'HTML' : endpoint.response ? 'HTTP' : 'TCP'
    return `:${endpoint.port} · ${format}`
  }
  forwarded(endpoint: ServerEndpoint): NativeServerForward | undefined { void this.state.revision; return this.#forwards.get(endpoint.endpointId)?.view }
  async stop() {
    const source = this.connected()
    const result = await source.api.runningServerStop(this.serverId)
    await this.commands.refresh()
    return result
  }
  async forward(endpoint: ServerEndpoint): Promise<NativeServerForward> {
    const endpointId = endpoint.endpointId
    const pending = this.#attempts.get(endpointId)
    if (pending) return pending
    const token = (this.#tokens.get(endpointId) ?? 0) + 1
    this.#tokens.set(endpointId, token)
    const attempt = this.startForward(endpoint, token)
    this.#attempts.set(endpointId, attempt)
    try { return await attempt } finally {
      this.#attempts.delete(endpointId)
      if (!this.#forwards.has(endpointId)) this.#tokens.delete(endpointId)
    }
  }
  private async startForward(endpoint: ServerEndpoint, token: number): Promise<NativeServerForward> {
    const source = this.connected()
    const forwarding = this.commands.forwarding
    if (!forwarding) throw new Error('Port forwarding requires the desktop app.')
    if (!this.endpoints.some((candidate) => candidate.endpointId === endpoint.endpointId)) throw new Error('This endpoint is no longer available.')
    const generation = this.#generation
    const ticket = await source.api.runningServerTunnel(this.serverId, endpoint.endpointId)
    const tunnel = new URL(ticket.relativeUrl, forwarding.origin())
    tunnel.protocol = tunnel.protocol === 'https:' ? 'wss:' : 'ws:'
    const view = await forwarding.start({ endpointKey: this.forwardKey(endpoint), tunnelUrl: tunnel.href, targetUrl: endpoint.url, expiresAt: ticket.expiresAt })
    if (!this.#present || generation !== this.#generation || source !== this.commands.source() || this.#tokens.get(endpoint.endpointId) !== token) {
      await forwarding.stop(view.forwardId)
      throw new Error('The server or host connection changed.')
    }
    const previous = this.#forwards.get(endpoint.endpointId)
    this.#forwards.set(endpoint.endpointId, { view, release: previous?.release ?? this.commands.retain(this.checkoutPath) })
    if (!previous || previous.view.forwardId !== view.forwardId) this.changed()
    return view
  }
  async stopForward(forwardId: string): Promise<void> {
    for (const [endpointId, forward] of this.#forwards) if (forward.view.forwardId === forwardId) {
      this.#tokens.set(endpointId, (this.#tokens.get(endpointId) ?? 0) + 1)
      this.#forwards.delete(endpointId)
      forward.release()
      this.changed()
      await this.commands.forwarding?.stop(forwardId)
      if (!this.#attempts.has(endpointId)) this.#tokens.delete(endpointId)
    }
  }
  /** A host on this computer needs no forward: its endpoint URL already reaches the port. */
  async openExternal(endpoint: ServerEndpoint, { isLocalHost = false }: { isLocalHost?: boolean } = {}): Promise<void> {
    if (!this.commands.forwarding) throw new Error('Use the host browser, or the desktop app to forward this port.')
    const url = isLocalHost ? endpoint.url : (await this.forward(endpoint)).url
    if (!await this.commands.forwarding.openExternal(url)) throw new Error('Cannot open the system browser.')
  }
  async renewForwards(): Promise<void> {
    for (const [endpointId, forward] of this.#forwards) {
      const endpoint = this.endpoints.find((candidate) => candidate.endpointId === endpointId)
      try {
        if (!endpoint) await this.stopForward(forward.view.forwardId)
        else await this.forward(endpoint)
      } catch { await this.stopForward(forward.view.forwardId).catch(() => {}) }
    }
  }
  async restoreForward(forward: NativeServerForward): Promise<boolean> {
    const endpoint = this.endpoints.find((candidate) => this.forwardKey(candidate) === forward.endpointKey)
    if (!endpoint) return false
    await this.forward(endpoint)
    return true
  }
  dispose(): void {
    this.#present = false
    this.#generation++
    for (const forward of this.forwards) void this.stopForward(forward.forwardId).catch(() => {})
  }
  private changed(): void { this.state.revision++; this.commands.changed() }
  private connected(): RunningServersSource {
    const source = this.commands.source()
    if (!this.#present || !source?.ready) throw new Error('This server is no longer connected.')
    return source
  }
  private forwardKey(endpoint: ServerEndpoint): string { return `${this.commands.forwarding?.keyPrefix}:${this.serverId}:${endpoint.endpointId}` }
}
