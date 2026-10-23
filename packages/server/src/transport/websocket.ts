import { randomBytes } from 'crypto'
import type { IncomingMessage, Server as HttpServer } from 'http'
import type { Duplex } from 'stream'
import { Server, type Socket } from 'socket.io'
import type { CallerCtx, RpcInvocationArgs, RpcInvocationResult, SolusServer } from './server'
import type { ClientEventRegistry } from './events/client-event-registry'
import type { BrowserFrameChannel } from '../browser/browser-frame-channel'
import { RpcAccessError } from '../admission/access-policy'
import { PlaneDisabledError } from '../host/roles'
import { GithubConnectionRequiredError } from '../providers/github/connection-required'
import { RequestNotAnswerableError } from '../execution/sessions/pending-input'
import { WorkMovedError } from '../data/works/work'
import { ShareAccessError } from '../sharing/share-manager'
import { SeatRequiredError } from '../execution/seats/seat-manager'
import { TurnRefusedError } from '../execution/sessions/turn-refusal'
import { WorkspacePreparingError } from '../host/member-users'
import { CREDENTIAL_FREE_PRINCIPAL, principalExpiresAt, principalSchema, renewalExpiry, type Principal } from '../admission/principal'
import type { Doors } from '../admission/doors'
import { SOLUS_PROTOCOL, UPDATE_REQUIRED, socketHandshakeSchema } from '@solus/contracts/uplink'
import type { TokenVerdict } from '../admission/access-tokens'
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
  /** Ends every socket whose principal matches: a revoked guest link is gone within the second (§3.4). */
  disconnectWhere: (predicate: (principal: Principal) => boolean, reason: string) => number
  /** The principal behind a client id, for event audiences. */
  principalOf: (clientId: string) => Principal | null
  /** Sends one event to a client's newest socket and resolves with its parsed acknowledgement; rejects when it has none, the ack is late, or unreadable. */
  request: <Payload, Answer>(clientId: string, event: string, payload: Payload, answer: z.ZodType<Answer>, timeoutMs: number) => Promise<Answer>
}

/** Set by the engine middleware from the listener the request arrived on; never by a client. */
const VIA_TUNNEL_HEADER = 'x-solus-via-tunnel'

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
  principal: Principal
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
    /** Verifies the next access token a token-admitted socket sends (`authRenew`). Absent: a socket ends at its token's expiry. */
    verifyAccessToken?: (token: string) => Promise<TokenVerdict>
    /** Admits the one credential a handshake presents (`admission/doors.ts`). Absent: no credential admits a socket. */
    doors?: Doors
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
  // socket. Solus does not read it after admission, so it is released below in
  // the `connection` handler. It must not be released earlier: Socket.IO reads
  // `conn.request` lazily when it builds the handshake, so nulling it on the
  // engine's own `connection` event left `handshake.headers` empty and the
  // tunnel marker unread — every tunnel socket then looked like a loopback one.
  const sessions = new Map<string, ClientSession>()
  const responseCaches = new Map<string, ResponseReceiptCache<WsResponse>>()
  const responseBudget = opts.responseBudget ?? new ResponseReceiptBudget()
  const clientSocketCounts = new Map<string, number>()
  const eventUnregisters = new Map<string, () => void>()
  const frameUnregisters = new Map<string, () => void>()
  const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let closing = false

  io.use(async (socket, next) => {
    const refuse = (message: string): void => next(Object.assign(new Error(message), { data: { code: message === UPDATE_REQUIRED ? UPDATE_REQUIRED : 'UNAUTHORIZED' } }))
    // A client that does not speak this protocol is told to update (plan §4.6), before anything else is read.
    const parsed = socketHandshakeSchema.safeParse(socket.handshake.auth)
    if (!parsed.success || parsed.data.protocol !== SOLUS_PROTOCOL) {
      refuse(UPDATE_REQUIRED)
      return
    }
    const handshake = parsed.data
    const admit = (principal: Principal): void => {
      const instanceId = handshake.clientInstanceId ?? randomBytes(16).toString('hex')
      // A host's delegated token opens the runner HTTP routes, never a socket.
      if (principal.kind === 'runner') {
        refuse('unauthorized')
        return
      }
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
    // The one credential the handshake presents is the whole admission (plan §3 rule 4).
    if (handshake.credential) {
      const admission = opts.doors ? await opts.doors.admitCredential(handshake.credential).catch(() => null) : null
      if (admission?.ok) {
        admit(admission.principal)
        return
      }
      log.info('ws_credential_refused', { credential: handshake.credential.kind, reason: admission ? admission.reason : 'no-door' })
      refuse('unauthorized')
      return
    }
    // Tunnel traffic is loopback on the wire and the bind policy may be open on
    // loopback; neither may admit it. Only a credential does (the proxied-listener rule).
    if (socket.handshake.headers[VIA_TUNNEL_HEADER] === '1') {
      refuse('unauthorized')
      return
    }
    if (!requireAuth()) {
      admit(CREDENTIAL_FREE_PRINCIPAL)
      return
    }
    // The bind policy relaxes for trusted requesters — the same relaxation
    // /health advertises to them, so a client told it may connect tokenless
    // must actually be admitted here.
    const trusted = await Promise.resolve(opts.isTrustedRequester?.(socket.handshake.address) ?? false).catch(() => false)
    if (trusted) admit(CREDENTIAL_FREE_PRINCIPAL)
    else refuse('unauthorized')
  })

  io.on('connection', (socket) => {
    // The handshake is built by now; the request graph can go.
    Object.assign(socket.conn, { request: null })
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
    const session: ClientSession = { id, clientId, socket, deviceId, deviceLabel, principal, connectedAt: Date.now() }
    sessions.set(id, session)
    opts.onClientConnected?.({ clientId, deviceId })
    socket.emit('hello')

    // A grant admits a socket for the grant's lifetime and no longer: the socket
    // ends at expiry, and the re-dial needs a grant a revoked device cannot get.
    // The client's next access token moves the end (`authRenew`; ADR 0001 rule 4).
    let grantTimer: ReturnType<typeof setTimeout> | null = null
    const endAt = (expiresAt: number): void => {
      if (grantTimer) clearTimeout(grantTimer)
      grantTimer = setTimeout(() => {
        log.info('ws_session_grant_expired', { id, clientId })
        socket.disconnect(true)
      }, Math.max(0, expiresAt - Date.now()))
      grantTimer.unref?.()
    }
    const expiresAt = principalExpiresAt(principal)
    if (expiresAt !== null) {
      endAt(expiresAt)
      socket.once('disconnect', () => { if (grantTimer) clearTimeout(grantTimer) })
    }
    const verifyAccessToken = opts.verifyAccessToken
    const renewAccess = expiresAt !== null && verifyAccessToken && ((principal.kind === 'owner' && principal.via === 'grant') || principal.kind === 'org-member')
      ? async (accessToken: string): Promise<number> => {
        const verdict = await verifyAccessToken(accessToken)
        const renewedAt = verdict.ok ? renewalExpiry(principal, verdict.claims) : null
        if (renewedAt === null) {
          log.info('ws_session_renewal_refused', { id, clientId, reason: verdict.ok ? 'other-standing' : verdict.reason })
          throw new Error('This token does not continue this connection.')
        }
        // The principal object is the one every call on this socket reads.
        principal.expiresAt = renewedAt
        endAt(renewedAt)
        return renewedAt
      }
      : undefined

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
        renewAccess,
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
    disconnectWhere: (predicate, reason) => {
      let count = 0
      // A disconnect removes its session from the map, so iterate a copy.
      for (const session of Array.from(sessions.values())) {
        if (!predicate(session.principal)) continue
        log.info('ws_session_ended_by_host', { id: session.id, clientId: session.clientId, reason })
        session.socket.disconnect(true)
        count += 1
      }
      return count
    },
    principalOf: (clientId) => {
      for (const session of sessions.values()) if (session.clientId === clientId) return session.principal
      return null
    },
    request: async (clientId, event, payload, answer, timeoutMs) => {
      let newest: ClientSession | undefined
      for (const session of sessions.values()) {
        if (session.clientId === clientId && (!newest || session.connectedAt >= newest.connectedAt)) newest = session
      }
      if (!newest) throw new Error(`No socket for ${clientId}`)
      return answer.parse(await newest.socket.timeout(timeoutMs).emitWithAck(event, payload))
    },
    close: () => {
      if (closing) return
      closing = true
      // A listener rebind keeps the presence manager alive. End each client's
      // presence before discarding the sockets, once even with several sockets.
      const disconnectedClients = new Map<string, string | null>()
      for (const session of sessions.values()) disconnectedClients.set(session.clientId, session.deviceId)
      for (const [clientId, deviceId] of disconnectedClients) opts.onClientDisconnected?.({ clientId, deviceId })
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
  ctx: CallerCtx,
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
      if (err instanceof RpcAccessError) {
        // A client surface that calls what its principal may not: the answer is the
        // refusal, the log is how a guest shell is audited for host-wide reach.
        log.info('rpc_access_refused', { clientId, method: request.method, principal: err.principalKind })
        return { error: { message: err.message, code: err.code } }
      }
      // No seat, no turn: the code is what lets the client raise the connect card.
      if (err instanceof SeatRequiredError) return { error: { message: err.message, code: err.code } }
      // A member the host has not made a user for yet: the client shows that it is setting up (member-isolation §8.1).
      if (err instanceof WorkspacePreparingError) return { error: { message: err.message, code: err.code } }
      // A turn the organization model refused: the client keeps the draft and says why (organization-vms §4).
      if (err instanceof TurnRefusedError) return { error: { message: err.message, code: err.code } }
      // A plane this host does not serve: the client asks the host that does.
      if (err instanceof PlaneDisabledError) return { error: { message: err.message, code: err.code } }
      // No GitHub on the account: the client offers its Connections page.
      if (err instanceof GithubConnectionRequiredError) return { error: { message: err.message, code: err.code } }
      // A shared work: the client asks the host that has it now (cloud-sharing.md §3a).
      if (err instanceof WorkMovedError) return { error: { message: err.message, code: err.code } }
      // A permission or question the host no longer holds: the client closes the card.
      if (err instanceof RequestNotAnswerableError) return { error: { message: err.message, code: err.code } }
      // A share rule refused the caller: the code tells a refusal from a failure, as an access-policy refusal does.
      if (err instanceof ShareAccessError) return { error: { message: err.message, code: err.code } }
      const message = err instanceof Error ? err.message : String(err)
      log.warn('rpc_handler_error', { clientId, method: request.method, error: message })
      return { error: { message } }
    }
  })
}
