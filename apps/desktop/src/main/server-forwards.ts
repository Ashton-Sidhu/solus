import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { WebSocket, createWebSocketStream } from 'ws'
import { z } from 'zod'
import type { NativeServerForward, NativeServerForwardRequest } from '@solus/contracts/running-servers'

export const serverForwardRequestSchema = z.object({
  endpointKey: z.string().min(1).max(8192),
  tunnelUrl: z.string().url().refine((raw) => { const url = new URL(raw); return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && /^\/api\/running-servers\/tunnel\/[\w-]{43}$/.test(url.pathname) && !url.search && !url.hash }),
  targetUrl: z.string().url().refine((raw) => { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password }),
  expiresAt: z.number().finite(),
})
interface Forward { view: NativeServerForward; server: Server; sockets: Set<Socket>; request: NativeServerForwardRequest; expiry: ReturnType<typeof setTimeout> }

/** The desktop binds loopback. The selected host owns the remote TCP endpoint. */
export class ServerForwards {
  private readonly forwards = new Map<string, Forward>()
  private readonly opening = new Map<string, Promise<NativeServerForward>>()

  async start(input: NativeServerForwardRequest): Promise<NativeServerForward> {
    const request = serverForwardRequestSchema.parse(input)
    const existing = this.forwards.get(request.endpointKey)
    if (existing) {
      existing.request = request
      clearTimeout(existing.expiry)
      existing.expiry = this.expiry(request)
      return existing.view
    }
    const opening = this.opening.get(request.endpointKey)
    if (opening) return opening
    if (this.forwards.size + this.opening.size >= 32) throw new Error('Too many forwarded ports.')
    const started = this.open(request).finally(() => this.opening.delete(request.endpointKey))
    this.opening.set(request.endpointKey, started)
    return started
  }

  private async open(request: NativeServerForwardRequest): Promise<NativeServerForward> {
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      const current = this.forwards.get(request.endpointKey)
      if (!current || current.request.expiresAt <= Date.now() || sockets.size >= 32) { socket.destroy(); return }
      sockets.add(socket)
      const webSocket = new WebSocket(current.request.tunnelUrl, { handshakeTimeout: 10_000, maxPayload: 1024 * 1024, perMessageDeflate: false })
      const stream = createWebSocketStream(webSocket)
      const close = () => { sockets.delete(socket); socket.destroy(); stream.destroy(); webSocket.terminate() }
      socket.on('error', close)
      stream.on('error', close)
      webSocket.on('error', close)
      socket.once('close', close)
      webSocket.once('close', close)
      socket.pipe(stream).pipe(socket)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    const address = z.object({ port: z.number().int().positive() }).safeParse(server.address())
    if (!address.success) { server.close(); throw new Error('Cannot bind a local port.') }
    const url = new URL(request.targetUrl)
    url.hostname = '127.0.0.1'
    url.port = String(address.data.port)
    const view = { forwardId: randomUUID(), endpointKey: request.endpointKey, localPort: address.data.port, url: url.href }
    this.forwards.set(request.endpointKey, { view, server, sockets, request, expiry: this.expiry(request) })
    return view
  }

  private expiry(request: NativeServerForwardRequest): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.stopKey(request.endpointKey), Math.max(0, Math.min(request.expiresAt - Date.now(), 120_000)))
    timer.unref()
    return timer
  }

  list(): NativeServerForward[] { return [...this.forwards.values()].map((forward) => forward.view) }
  stop(forwardId: string): void { for (const [key, forward] of this.forwards) if (forward.view.forwardId === forwardId) this.stopKey(key) }
  private stopKey(key: string): void {
    const forward = this.forwards.get(key)
    if (!forward) return
    this.forwards.delete(key)
    clearTimeout(forward.expiry)
    for (const socket of forward.sockets) socket.destroy()
    forward.server.close()
  }
  close(): void { for (const key of this.forwards.keys()) this.stopKey(key) }
}
