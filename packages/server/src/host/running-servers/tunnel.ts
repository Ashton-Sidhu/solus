import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, createWebSocketStream, type WebSocket } from 'ws'
import type { RunningServerTunnel } from '@solus/contracts/running-servers'
import type { RunningServerRegistry } from './registry'

const PREFIX = '/api/running-servers/tunnel/'
const TICKET_MS = 120_000
interface Ticket { clientId: string; serverId: string; endpointId: string; expiresAt: number }
interface Channel { clientId: string; webSocket: WebSocket; socket: Socket; expiry: ReturnType<typeof setTimeout> }

/** A short-lived capability for exactly one listed loopback endpoint. Never an HTTP proxy. */
export class RunningServerTunnels {
  private readonly tickets = new Map<string, Ticket>()
  private readonly channels = new Set<Channel>()
  private readonly upgrades = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false })

  constructor(private readonly registry: Pick<RunningServerRegistry, 'list' | 'identityMatches'>) {}

  async issue(clientId: string, serverId: string, endpointId: string): Promise<RunningServerTunnel> {
    const server = (await this.registry.list()).find((candidate) => candidate.serverId === serverId)
    if (!server?.endpoints.some((endpoint) => endpoint.endpointId === endpointId)) throw new Error('This server endpoint is no longer available.')
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt < Date.now()) this.tickets.delete(key)
    const existing = [...this.tickets].find(([, ticket]) => ticket.clientId === clientId && ticket.serverId === serverId && ticket.endpointId === endpointId)
    if (!existing && [...this.tickets.values()].filter((ticket) => ticket.clientId === clientId).length >= 32) throw new Error('Too many forwarded server endpoints.')
    const key = existing?.[0] ?? randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + TICKET_MS
    this.tickets.set(key, { clientId, serverId, endpointId, expiresAt })
    return { relativeUrl: PREFIX + key, expiresAt }
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = request.url?.split('?')[0] ?? ''
    if (!path.startsWith(PREFIX)) return false
    void this.accept(path.slice(PREFIX.length), request, socket, head).catch(() => socket.destroy())
    return true
  }

  private async accept(key: string, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const ticket = this.tickets.get(key)
    if (!ticket || ticket.expiresAt < Date.now() || this.channels.size >= 256 || [...this.channels].filter((channel) => channel.clientId === ticket.clientId).length >= 32) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const server = (await this.registry.list(true)).find((candidate) => candidate.serverId === ticket.serverId)
    const endpoint = server?.endpoints.find((candidate) => candidate.endpointId === ticket.endpointId)
    if (!server || !endpoint || !['127.0.0.1', '::1', 'localhost'].includes(endpoint.address) || (server.process.pid && !await this.registry.identityMatches(server))) {
      socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n')
      return
    }
    // Recheck revocation after the asynchronous scan.
    if (this.tickets.get(key) !== ticket || ticket.expiresAt < Date.now()) { socket.destroy(); return }
    this.upgrades.handleUpgrade(request, socket, head, (webSocket) => {
      const upstream = connect({ host: endpoint.address === 'localhost' ? '127.0.0.1' : endpoint.address, port: endpoint.port })
      const stream = createWebSocketStream(webSocket)
      const expire = () => {
        const remaining = (this.tickets.get(key)?.expiresAt ?? 0) - Date.now()
        if (remaining <= 0) close()
        else { channel.expiry = setTimeout(expire, remaining); channel.expiry.unref() }
      }
      const channel = { clientId: ticket.clientId, webSocket, socket: upstream, expiry: setTimeout(expire, Math.max(0, ticket.expiresAt - Date.now())) }
      channel.expiry.unref()
      this.channels.add(channel)
      const close = () => {
        if (!this.channels.delete(channel)) return
        clearTimeout(channel.expiry)
        upstream.destroy(); stream.destroy(); webSocket.terminate()
      }
      upstream.setTimeout(10_000, () => { if (upstream.connecting) close() })
      upstream.once('connect', () => upstream.setTimeout(0))
      upstream.on('error', close)
      stream.on('error', close)
      upstream.once('close', close)
      webSocket.once('close', close)
      stream.pipe(upstream).pipe(stream)
    })
  }

  disconnect(clientId: string): void {
    for (const [key, ticket] of this.tickets) if (ticket.clientId === clientId) this.tickets.delete(key)
    for (const channel of this.channels) if (channel.clientId === clientId) { clearTimeout(channel.expiry); channel.webSocket.terminate(); channel.socket.destroy(); this.channels.delete(channel) }
  }

  close(): void {
    for (const clientId of new Set([...this.tickets.values()].map((ticket) => ticket.clientId))) this.disconnect(clientId)
    this.upgrades.close()
  }
}
