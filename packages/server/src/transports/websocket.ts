import { randomBytes } from 'crypto'
import type { IncomingMessage, Server as HttpServer } from 'http'
import type { Duplex } from 'stream'
import { Server, type Socket } from 'socket.io'
import type { HandlerCtx, RpcInvocationArgs, RpcInvocationResult, SolusServer } from '../server/server'
import type { ClientEventRegistry } from '../events/client-event-registry'
import type { BrowserFrameChannel } from '../browser/browser-frame-channel'
import { consumeWsTicket } from '../server/auth'
import { RpcAccessError } from '../server/access-policy'
import { principalFor, principalSchema, type AdmissionEvidence } from '../server/principal'
import { createLogger } from '../logger'
import { ResponseReceiptBudget, ResponseReceiptCache } from './response-receipt-cache'
import { z } from 'zod'

const log = createLogger('main', 'ws-transport')
const STREAM_TTL_MS = 6 * 60_000
// RPC requests are not size-bounded at the transport. Use MAX_SAFE_INTEGER rather
// than Infinity: engine.io sends this value as `maxPayload` in the handshake JSON,
// and Infinity serializes to null there.
const MAX_HTTP_BUFFER_SIZE = Number.MAX_SAFE_INTEGER
export const FRAME_COMPRESSION_OPTIONS = { threshold: 1024 } as const

interface WsRequest {
  id: string
  method: string
  args: RpcInvocationArgs
}

interface WsResponse {
  result?: RpcInvocationResult
  error?: { message: string; code?: string }
}

interface WebSocketTransport {
  close: () => void
  sessions: Map<string, ClientSession>
  /** Lets a second listener (the tunnel's proxied port) hand its `/ws` upgrades to the same Socket.IO server. */
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
}

/** Set by the engine middleware from the listener the request arrived on; never by a client. */
const VIA_TUNNEL_HEADER = 'x-solus-via-tunnel'

const socketAuthSchema = z.object({
  /** Short-lived single-purpose handshake ticket (dispatch-client step 4). */
  ticket: z.string().optional(),
  clientInstanceId: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/).optional(),
})

const clientDataSchema = z.object({
  clientId: z.string(),
  deviceId: z.string().nullable(),
  deviceLabel: z.string(),
  principal: principalSchema,
})

const rpcWireSchema = z.object({
  id: z.string(),
  method: z.string(),
  args: z.array(z.any()),
})

interface ClientSession {
  id: string
  clientId: string
  socket: Socket
  deviceId: string | null
  deviceLabel: string
  connectedAt: number
}

type ClientData = z.infer<typeof clientDataSchema>

/** Mounts the Socket.IO transport at `/ws` on the shared HTTP server. */
export function attachWebSocketTransport(
  http: HttpServer,
  server: SolusServer,
  opts: {
    clientEvents: ClientEventRegistry
    /** The binary browser-frame side-channel. A per-client delivery is registered
     *  alongside the host-event one, so streamed JPEG frames reach the same
     *  sockets host events do — just as raw binary frames rather than JSON. */
    browserFrames?: BrowserFrameChannel
    requireAuth?: boolean | (() => boolean)
    /** Requester addresses allowed past a require-auth bind without a token
     *  (the machine itself, the host's own tailnet). Untrusted when absent. */
    isTrustedRequester?: (address: string | undefined) => Promise<boolean>
    /** True for a request that arrived through the tunnel's proxied listener.
     *  Such a request is loopback on the wire and must never be trusted for it. */
    isTunnelRequest?: (request: IncomingMessage) => boolean
    responseBudget?: ResponseReceiptBudget
    onClientConnected?: (client: { clientId: string; deviceId: string | null }) => void
    onClientDisconnected?: (client: { clientId: string; deviceId: string | null }) => void
    onClientExpired?: (client: { clientId: string; deviceId: string | null }) => void
  },
): WebSocketTransport {
  const requireAuth = (): boolean => {
    if (opts.requireAuth === false) return false
    if (opts.requireAuth === true || opts.requireAuth === undefined) return true
    return opts.requireAuth()
  }
  const io = new Server(http, {
    path: '/ws',
    transports: ['websocket'],
    perMessageDeflate: FRAME_COMPRESSION_OPTIONS,
    pingInterval: 15_000,
    pingTimeout: 10_000,
    maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
    connectionStateRecovery: {
      maxDisconnectionDuration: STREAM_TTL_MS,
      skipMiddlewares: false,
    },
  })
  // A local desktop renderer uses the same WebSocket transport as a remote
  // client. Remove the extension offer on loopback before ws negotiates it, so
  // host events and RPC acknowledgements both avoid local zlib work.
  io.engine.use((request, _response, next) => {
    // The listener a request came in on is the only trustworthy origin marker:
    // whatever a client sent under this header is replaced before admission reads it.
    if (opts.isTunnelRequest?.(request)) request.headers[VIA_TUNNEL_HEADER] = '1'
    else delete request.headers[VIA_TUNNEL_HEADER]
    if (isLoopbackAddress(request.socket.remoteAddress)) {
      delete request.headers['sec-websocket-extensions']
    }
    next()
  })
  // Socket.IO owns heartbeat/reconnect and missed-event replay. The receipt
  // cache below is intentionally narrower: Socket.IO retries do not prevent a
  // mutating RPC from running twice when its acknowledgement is lost. See
  // docs/adr/0004-socket-io-owns-wire-recovery-solus-owns-rpc-receipts.md.
  // Engine.IO retains the initial HTTP request for the lifetime of each raw
  // socket. Solus does not read it after authentication, so release it as
  // recommended by Socket.IO to avoid retaining headers/request graphs per
  // connected client.
  io.engine.on('connection', (rawSocket) => {
    rawSocket.request = null
  })
  const sessions = new Map<string, ClientSession>()
  const responseCaches = new Map<string, ResponseReceiptCache<WsResponse>>()
  const responseBudget = opts.responseBudget ?? new ResponseReceiptBudget()
  const clientSocketCounts = new Map<string, number>()
  const eventUnregisters = new Map<string, () => void>()
  const frameUnregisters = new Map<string, () => void>()
  const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let closing = false

  io.use((socket, next) => {
    const parsedAuth = socketAuthSchema.safeParse(socket.handshake.auth)
    const auth = parsedAuth.success ? parsedAuth.data : {}
    // One ticket admits one socket: a replayed handshake is refused even inside the TTL.
    const verified = auth.ticket ? consumeWsTicket(auth.ticket) : null
    const viaTunnel = socket.handshake.headers[VIA_TUNNEL_HEADER] === '1'
    const admit = (evidence: AdmissionEvidence): void => {
      const instanceId = auth.clientInstanceId ?? randomBytes(16).toString('hex')
      const principal = principalFor(evidence)
      const deviceId = principal.kind === 'system' ? null : principal.deviceId
      const data: ClientData = {
        clientId: `ws:${deviceId ?? 'local'}:${instanceId}`,
        deviceId,
        deviceLabel: principal.kind === 'system' ? 'Web' : principal.deviceLabel,
        principal,
      }
      Object.assign(socket.data, data)
      next()
    }
    const reject = (): void => next(Object.assign(new Error('unauthorized'), { data: { code: 'UNAUTHORIZED' } }))
    if (verified) {
      admit({ kind: 'ticket', ticket: verified })
      return
    }
    // Tunnel traffic is loopback on the wire and the bind policy may be open on
    // loopback; neither may admit it. Only a ticket does (the proxied-listener rule).
    if (viaTunnel) {
      reject()
      return
    }
    if (!requireAuth()) {
      admit({ kind: 'credential-free' })
      return
    }
    // The bind policy relaxes for trusted requesters — the same relaxation
    // /health advertises to them, so a client told it may connect tokenless
    // must actually be admitted here.
    void Promise.resolve(opts.isTrustedRequester?.(socket.handshake.address) ?? false)
      .catch(() => false)
      .then((trusted) => {
        if (trusted) admit({ kind: 'credential-free' })
        else reject()
      })
  })

  io.on('connection', (socket) => {
    const parsedClient = clientDataSchema.safeParse(socket.data)
    if (!parsedClient.success) {
      socket.disconnect(true)
      return
    }
    const { clientId, deviceId, deviceLabel, principal } = parsedClient.data
    const room = `client:${clientId}`
    void socket.join(room)

    const cleanupTimer = cleanupTimers.get(clientId)
    if (cleanupTimer) clearTimeout(cleanupTimer)
    cleanupTimers.delete(clientId)

    const previousCount = clientSocketCounts.get(clientId) ?? 0
    clientSocketCounts.set(clientId, previousCount + 1)
    if (previousCount === 0 && !eventUnregisters.has(clientId)) {
      eventUnregisters.set(clientId, opts.clientEvents.register(clientId, (event) => {
        io.to(room).emit('host-event', event)
      }))
    }
    // The JPEG rides as a real binary wire frame (Socket.IO detects the
    // Uint8Array and ships it as one); the header rides beside it as JSON. No
    // per-message deflate on loopback, so a desktop renderer's frames cost no
    // local zlib — the same relaxation host events already get above.
    if (previousCount === 0 && opts.browserFrames && !frameUnregisters.has(clientId)) {
      frameUnregisters.set(clientId, opts.browserFrames.register(clientId, (header, data) => {
        io.to(room).emit('browser-frame', header, data)
      }))
    }

    const id = randomBytes(8).toString('hex')
    const session: ClientSession = { id, clientId, socket, deviceId, deviceLabel, connectedAt: Date.now() }
    sessions.set(id, session)
    opts.onClientConnected?.({ clientId, deviceId })
    socket.emit('hello')

    // A grant admits a socket for the grant's lifetime and no longer: the socket
    // ends at expiry, and the re-dial needs a grant a revoked device cannot get.
    if (principal.kind === 'remote-owner') {
      const grantTimer = setTimeout(() => {
        log.info('ws_session_grant_expired', { id, clientId })
        socket.disconnect(true)
      }, Math.max(0, principal.expiresAt - Date.now()))
      grantTimer.unref?.()
      socket.once('disconnect', () => clearTimeout(grantTimer))
    }

    socket.on('rpc', async (id, method, args, ack) => {
      if (!(ack instanceof Function)) return
      const parsed = rpcWireSchema.safeParse({ id, method, args })
      if (!parsed.success) return
      // SAFETY: RPC method validation below pairs this wire array with the registered method's exact tuple.
      const request: WsRequest = { ...parsed.data, args: parsed.data.args as RpcInvocationArgs }
      const response = await getCachedResponse(responseCaches, responseBudget, clientId, request, server, {
        clientId,
        principal,
        deviceLabel,
        deviceId: deviceId ?? undefined,
      })
      ack(response)
    })

    socket.on('disconnect', (reason) => {
      sessions.delete(id)
      const remaining = Math.max(0, (clientSocketCounts.get(clientId) ?? 1) - 1)
      if (remaining > 0) clientSocketCounts.set(clientId, remaining)
      else clientSocketCounts.delete(clientId)

      if (!closing && remaining === 0) {
        opts.onClientDisconnected?.({ clientId, deviceId })
        const timer = setTimeout(() => {
          cleanupTimers.delete(clientId)
          if ((clientSocketCounts.get(clientId) ?? 0) > 0) return
          eventUnregisters.get(clientId)?.()
          eventUnregisters.delete(clientId)
          frameUnregisters.get(clientId)?.()
          frameUnregisters.delete(clientId)
          responseCaches.get(clientId)?.close()
          responseCaches.delete(clientId)
          opts.onClientExpired?.({ clientId, deviceId })
        }, STREAM_TTL_MS)
        timer.unref?.()
        cleanupTimers.set(clientId, timer)
      }
      log.info('ws_session_closed', {
        id,
        clientId,
        deviceLabel,
        reason,
        connectedMs: Date.now() - session.connectedAt,
        recovered: socket.recovered,
      })
    })

    log.info('ws_session_opened', { id, clientId, deviceLabel, deviceId, principal: principal.kind, recovered: socket.recovered })
  })

  return {
    // engine.io's own `attach` routes an HTTP upgrade through this same method.
    handleUpgrade: (request, socket, head) => io.engine.handleUpgrade(request, socket, head),
    close: () => {
      closing = true
      for (const timer of cleanupTimers.values()) clearTimeout(timer)
      cleanupTimers.clear()
      for (const unregister of eventUnregisters.values()) unregister()
      eventUnregisters.clear()
      for (const unregister of frameUnregisters.values()) unregister()
      frameUnregisters.clear()
      for (const cache of responseCaches.values()) cache.close()
      responseCaches.clear()
      clientSocketCounts.clear()
      sessions.clear()
      io.close()
    },
    sessions,
  }
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
  const firstOctet = Number(ipv4.split('.')[0])
  return Number.isInteger(firstOctet) && firstOctet === 127
}

function getCachedResponse(
  responseCaches: Map<string, ResponseReceiptCache<WsResponse>>,
  responseBudget: ResponseReceiptBudget,
  clientId: string,
  request: WsRequest,
  server: SolusServer,
  ctx: HandlerCtx,
): Promise<WsResponse> {
  let cache = responseCaches.get(clientId)
  if (!cache) {
    cache = new ResponseReceiptCache<WsResponse>(() => ({
      error: { message: 'Too many RPC requests are already in progress' },
    }), responseBudget)
    responseCaches.set(clientId, cache)
  }

  return cache.getOrCreate(request.id, async (): Promise<WsResponse> => {
    try {
      if (!server.hasHandler(request.method)) {
        return { error: { message: `Unknown method "${request.method}"` } }
      }
      return { result: await server.handle(request.method, request.args ?? [], ctx) }
    } catch (err) {
      if (err instanceof RpcAccessError) return { error: { message: err.message, code: err.code } }
      return { error: { message: err instanceof Error ? err.message : String(err) } }
    }
  })
}
