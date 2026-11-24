import { randomBytes } from 'node:crypto'
import { connect, type TcpNetConnectOpts } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, createWebSocketStream } from 'ws'
import { RUNNING_SERVER_TUNNEL_PATH, isRunningServerTunnelPath, type RunningServerTunnel } from '@solus/contracts/running-servers'
import type { RunningServerRegistry } from './registry'

const TICKET_MS = 120_000
type Target = { kind: 'server'; serverId: string; endpointId: string; address: string; port: number } | { kind: 'port'; port: number }
interface Ticket { clientId: string; target: Target; expiresAt: number }
interface Channel { clientId: string; close(): void }

/** A short-lived capability for one loopback TCP endpoint. */
export class RunningServerTunnels {
  private readonly tickets = new Map<string, Ticket>()
  private readonly channels = new Set<Channel>()
  private readonly pending = new Map<string, { count: number }>()
  private readonly upgrades = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false })

  constructor(
    private readonly registry: Pick<RunningServerRegistry, 'list' | 'identityMatches'>,
    private readonly isControlPort: (port: number) => boolean,
    private readonly isEnabled: () => boolean,
  ) {}

  async issue(clientId: string, serverId: string, endpointId: string): Promise<RunningServerTunnel> {
    this.requireEnabled()
    const pending = this.pending.get(clientId) ?? { count: 0 }
    pending.count++
    this.pending.set(clientId, pending)
    try {
      const server = (await this.registry.list()).find((candidate) => candidate.serverId === serverId)
      if (this.pending.get(clientId) !== pending) throw new Error('The preview tunnel request was revoked.')
      const endpoint = server?.endpoints.find((candidate) => candidate.endpointId === endpointId)
      if (!endpoint || !isLoopback(endpoint.address)) throw new Error('This loopback endpoint is no longer available.')
      if (this.isControlPort(endpoint.port)) throw new Error('This port is reserved for the Solus host connection.')
      return this.issueTicket(clientId, { kind: 'server', serverId, endpointId, address: endpoint.address, port: endpoint.port })
    } finally {
      pending.count--
      if (!pending.count && this.pending.get(clientId) === pending) this.pending.delete(clientId)
    }
  }

  issuePort(clientId: string, port: number): RunningServerTunnel {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a TCP port from 1 to 65535.')
    if (this.isControlPort(port)) throw new Error('This port is reserved for the Solus host connection.')
    return this.issueTicket(clientId, { kind: 'port', port })
  }

  private requireEnabled(): void {
    if (!this.isEnabled()) throw new Error('The preview tunnel is disabled on this host.')
  }

  private issueTicket(clientId: string, target: Target): RunningServerTunnel {
    this.requireEnabled()
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt < Date.now()) this.tickets.delete(key)
    const existing = [...this.tickets].find(([, ticket]) => ticket.clientId === clientId && sameTarget(ticket.target, target))
    if (!existing && [...this.tickets.values()].filter((ticket) => ticket.clientId === clientId).length >= 32) throw new Error('Too many forwarded server endpoints.')
    const key = existing?.[0] ?? randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + TICKET_MS
    if (existing) existing[1].expiresAt = expiresAt
    else this.tickets.set(key, { clientId, target, expiresAt })
    return { relativeUrl: RUNNING_SERVER_TUNNEL_PATH + key, expiresAt }
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = request.url ?? ''
    if (!path.startsWith(RUNNING_SERVER_TUNNEL_PATH)) return false
    if (!isRunningServerTunnelPath(path)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return true
    }
    void this.accept(path.slice(RUNNING_SERVER_TUNNEL_PATH.length), request, socket, head).catch(() => socket.destroy())
    return true
  }

  private async accept(key: string, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const ticket = this.tickets.get(key)
    if (!ticket || !this.mayUpgrade(key, ticket)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const endpoint = await this.endpointFor(ticket.target)
    if (!endpoint || this.isControlPort(endpoint.port)) {
      socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n')
      return
    }
    // The policy, connection and capacity can change while discovery runs.
    if (!this.mayUpgrade(key, ticket)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    this.upgrades.handleUpgrade(request, socket, head, (webSocket) => {
      const upstream = connect(endpoint)
      const stream = createWebSocketStream(webSocket)
      const expire = () => {
        const remaining = (this.tickets.get(key)?.expiresAt ?? 0) - Date.now()
        if (remaining <= 0) close()
        else { expiry = setTimeout(expire, remaining); expiry.unref() }
      }
      const close = () => {
        if (!this.channels.delete(channel)) return
        clearTimeout(expiry)
        upstream.destroy()
        stream.destroy()
        webSocket.terminate()
      }
      const channel = { clientId: ticket.clientId, close }
      let expiry = setTimeout(expire, Math.max(0, ticket.expiresAt - Date.now()))
      expiry.unref()
      this.channels.add(channel)
      upstream.setTimeout(10_000, () => { if (upstream.connecting) close() })
      upstream.once('connect', () => upstream.setTimeout(0))
      upstream.on('error', close)
      stream.on('error', close)
      upstream.once('close', close)
      webSocket.once('close', close)
      stream.pipe(upstream).pipe(stream)
    })
  }

  private mayUpgrade(key: string, ticket: Ticket): boolean {
    return this.isEnabled() && this.tickets.get(key) === ticket && ticket.expiresAt > Date.now()
      && this.channels.size < 256 && [...this.channels].filter((channel) => channel.clientId === ticket.clientId).length < 32
  }

  private async endpointFor(target: Target): Promise<TcpNetConnectOpts | null> {
    if (target.kind === 'port') {
      return {
        host: 'localhost',
        port: target.port,
        autoSelectFamily: true,
        lookup: (_hostname, options, done) => {
          if (options.all) done(null, [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }])
          else if (options.family === 6) done(null, '::1', 6)
          else done(null, '127.0.0.1', 4)
        },
      }
    }
    const server = (await this.registry.list(true)).find((candidate) => candidate.serverId === target.serverId)
    const endpoint = server?.endpoints.find((candidate) => candidate.endpointId === target.endpointId)
    if (!server || !endpoint || endpoint.address !== target.address || endpoint.port !== target.port) return null
    if (server.process.pid && !await this.registry.identityMatches(server)) return null
    return { host: endpoint.address === 'localhost' ? '127.0.0.1' : endpoint.address, port: endpoint.port }
  }

  disconnect(clientId: string): void {
    this.pending.delete(clientId)
    for (const [key, ticket] of this.tickets) if (ticket.clientId === clientId) this.tickets.delete(key)
    for (const channel of this.channels) if (channel.clientId === clientId) channel.close()
  }

  applyPolicy(): void {
    if (!this.isEnabled()) this.revokeAll()
  }

  private revokeAll(): void {
    this.pending.clear()
    this.tickets.clear()
    for (const channel of this.channels) channel.close()
  }

  close(): void {
    this.revokeAll()
    this.upgrades.close()
  }
}

function sameTarget(held: Target, requested: Target): boolean {
  if (held.kind === 'port') return requested.kind === 'port' && held.port === requested.port
  return requested.kind === 'server' && held.serverId === requested.serverId && held.endpointId === requested.endpointId
    && held.address === requested.address && held.port === requested.port
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === 'localhost'
}
