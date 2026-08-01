import { randomBytes } from 'crypto'
import type { Server as HttpServer } from 'http'
import { Server, type Socket } from 'socket.io'
import type { SolusServer } from '../server/server'
import { RPC_TOPICS } from '../../shared/rpc'
import type { RpcTopic } from '../../shared/rpc'
import { verifySessionToken } from '../server/auth'
import { createLogger } from '../logger'
import { ResponseReceiptBudget, ResponseReceiptCache } from './response-receipt-cache'

const log = createLogger('main', 'ws-transport')
const STREAM_TTL_MS = 6 * 60_000
const MAX_HTTP_BUFFER_SIZE = 32 * 1024 * 1024

interface WsRequest {
  id: string
  method: string
  args?: unknown[]
}

interface WsResponse {
  result?: unknown
  error?: { message: string }
}

interface ClientSession {
  id: string
  clientId: string
  socket: Socket
  deviceId: string | null
  deviceLabel: string
  connectedAt: number
}

interface ClientData {
  clientId: string
  deviceId: string | null
  deviceLabel: string
}

/** Mounts the Socket.IO transport at `/ws` on the shared HTTP server. */
export function attachWebSocketTransport(
  http: HttpServer,
  server: SolusServer,
  opts: {
    requireAuth?: boolean | (() => boolean)
    responseBudget?: ResponseReceiptBudget
  } = {},
): { close: () => void; sessions: Map<string, ClientSession> } {
  const requireAuth = () => typeof opts.requireAuth === 'function' ? opts.requireAuth() : (opts.requireAuth ?? true)
  const io = new Server(http, {
    path: '/ws',
    transports: ['websocket'],
    pingInterval: 15_000,
    pingTimeout: 10_000,
    maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
    connectionStateRecovery: {
      maxDisconnectionDuration: STREAM_TTL_MS,
      skipMiddlewares: false,
    },
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
  const directUnsubs = new Map<string, () => void>()
  const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const topicUnsubs = RPC_TOPICS.map((topic) =>
    server.subscribe(topic, (payload) => io.emit('ev', topic, payload)),
  )
  let closing = false

  io.use((socket, next) => {
    const auth = socket.handshake.auth as { token?: unknown; clientInstanceId?: unknown }
    const token = typeof auth.token === 'string' ? auth.token : ''
    const verified = token ? verifySessionToken(token) : null
    if (requireAuth() && !verified) {
      const error = new Error('unauthorized') as Error & { data?: { code: string } }
      error.data = { code: 'UNAUTHORIZED' }
      next(error)
      return
    }

    const instanceId = typeof auth.clientInstanceId === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(auth.clientInstanceId)
      ? auth.clientInstanceId
      : randomBytes(16).toString('hex')
    const deviceId = verified?.deviceId ?? null
    const data: ClientData = {
      clientId: `ws:${deviceId ?? 'local'}:${instanceId}`,
      deviceId,
      deviceLabel: verified?.deviceLabel ?? 'Web',
    }
    Object.assign(socket.data, data)
    next()
  })

  io.on('connection', (socket) => {
    const { clientId, deviceId, deviceLabel } = socket.data as ClientData
    const room = `client:${clientId}`
    void socket.join(room)

    const cleanupTimer = cleanupTimers.get(clientId)
    if (cleanupTimer) clearTimeout(cleanupTimer)
    cleanupTimers.delete(clientId)

    const previousCount = clientSocketCounts.get(clientId) ?? 0
    clientSocketCounts.set(clientId, previousCount + 1)
    if (previousCount === 0 && !directUnsubs.has(clientId)) {
      directUnsubs.set(clientId, server.registerDirectClient(clientId, (topic, payload) => {
        io.to(room).emit('ev', topic, payload)
      }))
    }

    const id = randomBytes(8).toString('hex')
    const session: ClientSession = { id, clientId, socket, deviceId, deviceLabel, connectedAt: Date.now() }
    sessions.set(id, session)
    server.broadcast('presence', { type: 'connect', id, clientId, deviceLabel, deviceId })
    socket.emit('hello')

    socket.on('rpc', async (id: unknown, method: unknown, args: unknown, ack: unknown) => {
      if (typeof id !== 'string' || typeof method !== 'string' || typeof ack !== 'function') return
      const request: WsRequest = { id, method, args: Array.isArray(args) ? args : [] }
      const response = await getCachedResponse(responseCaches, responseBudget, clientId, request, server, {
        clientId,
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
        server.broadcast('presence', { type: 'disconnect', id, clientId, deviceId })
        const timer = setTimeout(() => {
          cleanupTimers.delete(clientId)
          if ((clientSocketCounts.get(clientId) ?? 0) > 0) return
          directUnsubs.get(clientId)?.()
          directUnsubs.delete(clientId)
          responseCaches.get(clientId)?.close()
          responseCaches.delete(clientId)
        }, STREAM_TTL_MS)
        ;(timer as unknown as { unref?: () => void }).unref?.()
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

    log.info('ws_session_opened', { id, clientId, deviceLabel, deviceId, recovered: socket.recovered })
  })

  return {
    close: () => {
      closing = true
      for (const timer of cleanupTimers.values()) clearTimeout(timer)
      cleanupTimers.clear()
      for (const unsubscribe of topicUnsubs) unsubscribe()
      for (const unsubscribe of directUnsubs.values()) unsubscribe()
      directUnsubs.clear()
      for (const cache of responseCaches.values()) cache.close()
      responseCaches.clear()
      clientSocketCounts.clear()
      sessions.clear()
      io.close()
    },
    sessions,
  }
}

function getCachedResponse(
  responseCaches: Map<string, ResponseReceiptCache<WsResponse>>,
  responseBudget: ResponseReceiptBudget,
  clientId: string,
  request: WsRequest,
  server: SolusServer,
  ctx: { clientId: string; deviceLabel: string; deviceId?: string },
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
      return { error: { message: err instanceof Error ? err.message : String(err) } }
    }
  })
}
