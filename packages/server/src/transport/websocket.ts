import { randomBytes } from 'crypto'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'http'
import type { Duplex } from 'stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { CallerCtx, RpcInvocationArgs, RpcInvocationResult, SolusServer } from './server'
import type { ClientEventRegistry } from './events/client-event-registry'
import type { HostEvent } from '@solus/contracts/host-events'
import type { BrowserFrameChannel } from '../browser/browser-frame-channel'
import { RpcAccessError } from '../admission/access-policy'
import { PlaneDisabledError } from '../host/roles'
import { GithubConnectionRequiredError } from '../providers/github/connection-required'
import { RequestNotAnswerableError } from '../execution/sessions/pending-input'
import { WorkMovedError } from '../data/works/work'
import { ShareAccessError } from '../sharing/share-manager'
import { SeatRequiredError } from '../execution/seats/seat-manager'
import { TurnRefusedError } from '../execution/sessions/turn-refusal'
import { PolicyRefusedError } from '../host/policy/host-policy-store'
import { WorkspacePreparingError } from '../host/member-users'
import { CREDENTIAL_FREE_PRINCIPAL, principalExpiresAt, principalSchema, renewalExpiry, type Principal } from '../admission/principal'
import type { Doors } from '../admission/doors'
import {
  clientFrameSchema,
  encodeBrowserFrame,
  HOST_SOCKET_CLOSE,
  HOST_SOCKET_PATH,
  HOST_SOCKET_PING_INTERVAL_MS,
  HOST_SOCKET_PING_TIMEOUT_MS,
  HOST_SOCKET_PROTOCOL_VERSION,
  splitTextFrame,
  type ClientFrame,
  type EventResume,
  type HelloFrame,
  type HostSocketRefusalCode,
  type ServerFrameInput,
} from '@solus/contracts/host-socket'
import type { TokenVerdict } from '../admission/access-tokens'
import { createLogger } from '../logger'
import { ResponseReceiptBudget, ResponseReceiptCache } from './response-receipt-cache'
import type { z } from 'zod'
import { couldBeForgedByWebPage } from './web-page-requests'

const log = createLogger('main', 'ws-transport')
/** How long a client's event stream and receipts outlive its last socket, so a short drop resumes without a reload. */
const STREAM_TTL_MS = 6 * 60_000
/** The most events kept for a resume. A client that missed more reloads instead. */
const MAX_REPLAY_EVENTS = 5_000
/** A socket that does not say `hello` in this time is closed. The credential can come from a slow account plane. */
const HELLO_TIMEOUT_MS = 30_000
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
  /** Lets a second listener (the tunnel's proxied port) hand its `/ws` upgrades to the same socket server. */
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  /** Ends every socket whose principal matches: a revoked guest link is gone within the second (§3.4). */
  disconnectWhere: (predicate: (principal: Principal) => boolean, reason: string) => number
  /** The principal behind a client id, for event audiences. */
  principalOf: (clientId: string) => Principal | null
  /** Sends one request to a client's newest socket and resolves with its parsed answer; rejects when it has none, the answer is late, or unreadable. */
  request: <Payload, Answer>(clientId: string, event: string, payload: Payload, answer: z.ZodType<Answer>, timeoutMs: number) => Promise<Answer>
}

/** Set from the listener the request arrived on; never by a client. */
const VIA_TUNNEL_HEADER = 'x-solus-via-tunnel'

interface ClientSession {
  id: string
  clientId: string
  socket: WebSocket
  deviceId: string | null
  deviceLabel: string
  principal: Principal
  connectedAt: number
  /** Ends this socket from the host's side. */
  end: (reason: string) => void
}

/** What admission reads from the upgrade request. The request itself is not kept. */
interface UpgradeFacts {
  address: string | undefined
  viaTunnel: boolean
  /** Whether a page on another site could have opened this socket (`web-page-requests.ts`). */
  couldBeForgedByWebPage: boolean
}

/** One raw socket, from its upgrade until it closes. */
interface Connection {
  ws: WebSocket
  facts: UpgradeFacts
  state: 'awaiting-hello' | 'admitting' | 'admitted' | 'closed'
  lastInboundAt: number
  /** The client said it joins parts of a text frame. */
  joinsFrameParts: boolean
  /** The caller of every RPC on this socket, once admitted. */
  ctx: CallerCtx | null
  /** The host's requests this socket has not answered yet. An answer is wire input; `request` parses it. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  pending: Map<string, { resolve: (answer: unknown) => void; reject: (error: Error) => void }>
  /** Runs once when the socket closes. */
  onClosed: Array<(reason: string) => void>
  connectedAt: number
}

/**
 * The events sent to one client, kept so that a client whose socket dropped gets what
 * it missed on its next socket (`resume` in its hello) instead of a reload. The epoch
 * names this log: a client never resumes from the numbers of another log.
 */
class ClientEventLog {
  readonly epoch = randomBytes(8).toString('hex')
  private seq = 0
  private readonly entries: Array<{ seq: number; at: number; frame: string }> = []

  get lastSeq(): number {
    return this.seq
  }

  /** Numbers and keeps one event, and returns its frame. */
  append(event: HostEvent): string {
    const seq = ++this.seq
    const frame = JSON.stringify({ t: 'event', seq, event } satisfies ServerFrameInput)
    const at = Date.now()
    this.entries.push({ seq, at, frame })
    while (this.entries.length > MAX_REPLAY_EVENTS || (this.entries[0] && this.entries[0].at < at - STREAM_TTL_MS)) this.entries.shift()
    return frame
  }

  /** The frames after `seq`, or null when some of them are gone (or `seq` is not from this log). */
  since(seq: number): string[] | null {
    if (seq > this.seq) return null
    if (seq === this.seq) return []
    const first = this.entries[0]
    if (!first || first.seq > seq + 1) return null
    return this.entries.slice(seq + 1 - first.seq).map((entry) => entry.frame)
  }
}

/** Mounts the host socket at `/ws` on the shared HTTP server (`@solus/contracts/host-socket`). */
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
  // RPC requests are not size-bounded at the transport (`maxPayload: 0`).
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: FRAME_COMPRESSION_OPTIONS, maxPayload: 0 })
  // The receipt cache makes a resent RPC run once: a dropped socket loses the
  // answer, and the client sends the request again on its next socket.
  const sessions = new Map<string, ClientSession>()
  const connections = new Set<Connection>()
  const responseCaches = new Map<string, ResponseReceiptCache<WsResponse>>()
  const responseBudget = opts.responseBudget ?? new ResponseReceiptBudget()
  /** The admitted sockets of each client. */
  const clientSockets = new Map<string, Set<Connection>>()
  const eventLogs = new Map<string, ClientEventLog>()
  const eventUnregisters = new Map<string, () => void>()
  const frameUnregisters = new Map<string, () => void>()
  const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let closing = false

  /** Sends a frame already serialized (an event, kept in its log as text). */
  const sendText = (connection: Connection, text: string): void => {
    if (connection.ws.readyState !== WebSocket.OPEN) return
    if (!connection.joinsFrameParts) {
      connection.ws.send(text)
      return
    }
    for (const part of splitTextFrame(text)) connection.ws.send(part)
  }
  const sendFrame = (connection: Connection, frame: ServerFrameInput): void => sendText(connection, JSON.stringify(frame))

  // One timer for every socket: a ping each interval, and an end for a socket silent past the timeout.
  const heartbeat = setInterval(() => {
    const now = Date.now()
    for (const connection of connections) {
      if (now - connection.lastInboundAt > HOST_SOCKET_PING_INTERVAL_MS + HOST_SOCKET_PING_TIMEOUT_MS) connection.ws.terminate()
      else sendFrame(connection, { t: 'ping' })
    }
  }, HOST_SOCKET_PING_INTERVAL_MS)
  heartbeat.unref?.()

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // The listener a request came in on is the only trustworthy origin marker:
    // whatever a client sent under this header is replaced before admission reads it.
    if (opts.isTunnelRequest?.(request)) request.headers[VIA_TUNNEL_HEADER] = '1'
    else delete request.headers[VIA_TUNNEL_HEADER]
    // A local desktop renderer uses the same socket as a remote client. Remove the
    // extension offer on loopback before ws negotiates it, so host events and RPC
    // answers avoid local zlib work.
    if (isLoopbackAddress(request.socket.remoteAddress)) delete request.headers['sec-websocket-extensions']
    const facts: UpgradeFacts = {
      address: request.socket.remoteAddress,
      viaTunnel: request.headers[VIA_TUNNEL_HEADER] === '1',
      couldBeForgedByWebPage: couldBeForgedByWebPage(request.headers),
    }
    wss.handleUpgrade(request, socket, head, (ws) => accept(ws, facts))
  }

  const onHttpUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (isHostSocketPath(request.url)) handleUpgrade(request, socket, head)
  }
  http.on('upgrade', onHttpUpgrade)
  // `/ws` is the socket's before any request handler: a plain request there gets
  // 426, never a page or a record route. The handlers that exist now run after this check.
  const requestListeners = http.listeners('request')
  const onHttpRequest = (request: IncomingMessage, response: ServerResponse): void => {
    if (isHostSocketPath(request.url)) {
      response.writeHead(426, { upgrade: 'websocket', connection: 'Upgrade' }).end()
      return
    }
    for (const listener of requestListeners) listener.call(http, request, response)
  }
  http.removeAllListeners('request')
  http.on('request', onHttpRequest)

  function accept(ws: WebSocket, facts: UpgradeFacts): void {
    if (closing) {
      ws.terminate()
      return
    }
    const connection: Connection = { ws, facts, state: 'awaiting-hello', lastInboundAt: Date.now(), joinsFrameParts: false, ctx: null, pending: new Map(), onClosed: [], connectedAt: Date.now() }
    connections.add(connection)
    const helloTimer = setTimeout(() => {
      if (connection.state === 'awaiting-hello') ws.close(HOST_SOCKET_CLOSE.protocol, 'no hello')
    }, HELLO_TIMEOUT_MS)
    helloTimer.unref?.()
    ws.on('message', (data, isBinary) => {
      connection.lastInboundAt = Date.now()
      receive(connection, data, isBinary)
    })
    ws.on('close', (code, reason) => {
      clearTimeout(helloTimer)
      connections.delete(connection)
      connection.state = 'closed'
      for (const request of connection.pending.values()) request.reject(new Error('The socket closed'))
      connection.pending.clear()
      const why = reason.toString() || String(code)
      for (const closed of connection.onClosed.splice(0)) closed(why)
    })
    ws.on('error', (error) => log.info('ws_socket_error', { error: error.message }))
  }

  /** Refuses a socket that is not admitted: the frame says why, then the socket ends. */
  function refuse(connection: Connection, code: HostSocketRefusalCode, message: string): void {
    connection.state = 'closed'
    sendFrame(connection, { t: 'refused', code, message })
    connection.ws.close(HOST_SOCKET_CLOSE.refused, message)
  }

  function receive(connection: Connection, data: RawData, isBinary: boolean): void {
    if (connection.state === 'closed') return
    const frame = isBinary ? null : parseClientFrame(data)
    if (frame?.t === 'pong') return
    if (connection.state === 'admitted') {
      // An admitted socket ignores a frame it cannot read, as a request it cannot answer.
      if (frame?.t === 'rpc') void answerRpc(connection, frame.id, frame.method, frame.args)
      else if (frame?.t === 'reply') {
        const request = connection.pending.get(frame.id)
        connection.pending.delete(frame.id)
        request?.resolve(frame.payload)
      }
      return
    }
    // The first frame is the hello, and nothing comes beside it until the welcome.
    if (connection.state !== 'awaiting-hello' || frame?.t !== 'hello') {
      refuse(connection, 'PROTOCOL', 'hello first')
      return
    }
    if (frame.v !== HOST_SOCKET_PROTOCOL_VERSION) {
      refuse(connection, 'PROTOCOL', 'unsupported protocol')
      return
    }
    connection.state = 'admitting'
    connection.joinsFrameParts = frame.frameParts === true
    void admitHello(connection, frame)
  }

  async function admitHello(connection: Connection, hello: HelloFrame): Promise<void> {
    const admitted = await admissionOf(hello, connection.facts)
    if (connection.state !== 'admitting') return
    // A host's delegated token opens the runner HTTP routes, never a socket.
    if (!admitted || admitted.kind === 'runner') {
      refuse(connection, 'UNAUTHORIZED', 'unauthorized')
      return
    }
    // Each socket reads and renews its own copy of the principal.
    const principal = principalSchema.safeParse(admitted)
    if (!principal.success) {
      refuse(connection, 'UNAUTHORIZED', 'unauthorized')
      return
    }
    admit(connection, principal.data, hello.clientInstanceId ?? randomBytes(16).toString('hex'), hello.resume)
  }

  /** The principal the hello admits, or null for a refusal. The rules apply in this order. */
  async function admissionOf(hello: HelloFrame, facts: UpgradeFacts): Promise<Principal | null> {
    // The one credential the handshake presents is the whole admission (plan §3 rule 4).
    if (hello.credential) {
      const admission = opts.doors ? await opts.doors.admitCredential(hello.credential).catch(() => null) : null
      if (admission?.ok) return admission.principal
      log.info('ws_credential_refused', { credential: hello.credential.kind, reason: admission ? admission.reason : 'no-door' })
      return null
    }
    // Tunnel traffic is loopback on the wire and the bind policy may be open on
    // loopback; neither may admit it. Only a credential does (the proxied-listener rule).
    if (facts.viaTunnel) return null
    // A page on another site, or a DNS-rebound name, may open a socket to loopback
    // too; network position and an open bind policy admit only what no page could forge.
    if (facts.couldBeForgedByWebPage) return null
    if (!requireAuth()) return CREDENTIAL_FREE_PRINCIPAL
    // The bind policy relaxes for trusted requesters — the same relaxation
    // /health advertises to them, so a client told it may connect tokenless
    // must actually be admitted here.
    const trusted = await Promise.resolve(opts.isTrustedRequester?.(facts.address) ?? false).catch(() => false)
    return trusted ? CREDENTIAL_FREE_PRINCIPAL : null
  }

  function admit(connection: Connection, principal: Principal, instanceId: string, resume: EventResume | undefined): void {
    if (principal.kind === 'runner') return
    const deviceId = principal.kind === 'system' ? null : principal.deviceId
    const deviceLabel = principal.kind === 'system' ? 'Web' : principal.deviceLabel
    const clientId = `ws:${deviceId ?? 'local'}:${instanceId}`
    const { ws } = connection
    connection.state = 'admitted'
    const eventLog = joinClient(clientId, connection)

    const id = randomBytes(8).toString('hex')
    const end = (reason: string): void => ws.close(HOST_SOCKET_CLOSE.ended, reason)
    const session: ClientSession = { id, clientId, socket: ws, deviceId, deviceLabel, principal, connectedAt: connection.connectedAt, end }
    sessions.set(id, session)
    const lifetime = grantLifetime(principal, opts.verifyAccessToken, end, { id, clientId })
    connection.ctx = { clientId, principal, deviceLabel, deviceId: deviceId ?? undefined, renewAccess: lifetime.renewAccess }

    const replay = resume && resume.epoch === eventLog.epoch ? eventLog.since(resume.seq) : null
    const recovered = replay !== null
    // The welcome goes before any event, and the replay before any new one.
    sendFrame(connection, { t: 'welcome', epoch: eventLog.epoch, seq: replay && resume ? resume.seq : eventLog.lastSeq, recovered })
    for (const frame of replay ?? []) sendText(connection, frame)

    connection.onClosed.push((reason) => {
      lifetime.stop()
      sessions.delete(id)
      leaveClient(clientId, deviceId, connection)
      log.info('ws_session_closed', { id, clientId, deviceLabel, reason, connectedMs: Date.now() - session.connectedAt, recovered })
    })

    opts.onClientConnected?.({ clientId, deviceId })
    log.info('ws_session_opened', { id, clientId, deviceLabel, deviceId, principal: principal.kind, recovered })
  }

  /** Adds an admitted socket to its client: the client's events and frames reach it from now on. */
  function joinClient(clientId: string, connection: Connection): ClientEventLog {
    const cleanupTimer = cleanupTimers.get(clientId)
    if (cleanupTimer) clearTimeout(cleanupTimer)
    cleanupTimers.delete(clientId)

    const sockets = clientSockets.get(clientId) ?? new Set<Connection>()
    clientSockets.set(clientId, sockets)
    sockets.add(connection)
    const eventLog = eventLogs.get(clientId) ?? new ClientEventLog()
    eventLogs.set(clientId, eventLog)
    if (!eventUnregisters.has(clientId)) {
      eventUnregisters.set(clientId, opts.clientEvents.register(clientId, (event) => {
        // Kept while no socket is up as well, so the next socket resumes from it.
        const frame = eventLog.append(event)
        for (const socket of clientSockets.get(clientId) ?? []) sendText(socket, frame)
      }))
    }
    // The JPEG rides as one binary frame with its header. No per-message deflate on
    // loopback, so a desktop renderer's frames cost no local zlib. Frames are not kept
    // for a resume: a stale picture is worse than a dropped one.
    if (opts.browserFrames && !frameUnregisters.has(clientId)) {
      frameUnregisters.set(clientId, opts.browserFrames.register(clientId, (header, data) => {
        const targets = clientSockets.get(clientId)
        if (!targets?.size) return
        const frame = encodeBrowserFrame(header, data)
        for (const socket of targets) if (socket.ws.readyState === WebSocket.OPEN) socket.ws.send(frame)
      }))
    }
    return eventLog
  }

  /** Removes a closed socket from its client. A client with no socket keeps its stream for a resume until the TTL ends. */
  function leaveClient(clientId: string, deviceId: string | null, connection: Connection): void {
    const sockets = clientSockets.get(clientId)
    sockets?.delete(connection)
    if (sockets && sockets.size > 0) return
    clientSockets.delete(clientId)
    if (closing) return
    opts.onClientDisconnected?.({ clientId, deviceId })
    const timer = setTimeout(() => {
      cleanupTimers.delete(clientId)
      if ((clientSockets.get(clientId)?.size ?? 0) > 0) return
      eventUnregisters.get(clientId)?.()
      eventUnregisters.delete(clientId)
      frameUnregisters.get(clientId)?.()
      frameUnregisters.delete(clientId)
      eventLogs.delete(clientId)
      responseCaches.get(clientId)?.close()
      responseCaches.delete(clientId)
      opts.onClientExpired?.({ clientId, deviceId })
    }, STREAM_TTL_MS)
    timer.unref?.()
    cleanupTimers.set(clientId, timer)
  }

  async function answerRpc(connection: Connection, id: string, method: string, args: unknown[]): Promise<void> {
    const ctx = connection.ctx
    if (!ctx) return
    // SAFETY: RPC method validation below pairs this wire array with the registered method's exact tuple.
    const request: WsRequest = { id, method, args: args as RpcInvocationArgs }
    const response = await getCachedResponse(responseCaches, responseBudget, ctx.clientId, request, server, ctx)
    sendFrame(connection, { t: 'result', id, ...response })
  }

  return {
    handleUpgrade,
    disconnectWhere: (predicate, reason) => {
      let count = 0
      for (const session of sessions.values()) {
        if (!predicate(session.principal)) continue
        log.info('ws_session_ended_by_host', { id: session.id, clientId: session.clientId, reason })
        session.end(reason)
        count += 1
      }
      return count
    },
    principalOf: (clientId) => {
      for (const session of sessions.values()) if (session.clientId === clientId) return session.principal
      return null
    },
    request: async (clientId, event, payload, answer, timeoutMs) => {
      let newest: Connection | undefined
      for (const connection of clientSockets.get(clientId) ?? []) {
        if (!newest || connection.connectedAt >= newest.connectedAt) newest = connection
      }
      if (!newest) throw new Error(`No socket for ${clientId}`)
      const target = newest
      const id = randomBytes(8).toString('hex')
      const reply = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          target.pending.delete(id)
          reject(new Error('operation has timed out'))
        }, timeoutMs)
        target.pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value) },
          reject: (error) => { clearTimeout(timer); reject(error) },
        })
        sendFrame(target, { t: 'request', id, event, payload })
      })
      return answer.parse(reply)
    },
    close: () => {
      if (closing) return
      closing = true
      clearInterval(heartbeat)
      http.off('upgrade', onHttpUpgrade)
      http.off('request', onHttpRequest)
      for (const listener of requestListeners) http.on('request', listener)
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
      eventLogs.clear()
      clientSockets.clear()
      sessions.clear()
      for (const connection of connections) connection.ws.terminate()
      connections.clear()
      wss.close()
    },
    sessions,
  }
}

/** How long one socket lives: the RPC that moves its end, and the stop for its timer. */
interface GrantLifetime {
  renewAccess: CallerCtx['renewAccess']
  stop: () => void
}

/**
 * A grant admits a socket for the grant's lifetime and no longer: the socket ends at
 * expiry, and the re-dial needs a grant a revoked device cannot get. The client's next
 * access token moves the end (`authRenew`; ADR 0001 rule 4).
 */
function grantLifetime(
  principal: Principal,
  verifyAccessToken: ((token: string) => Promise<TokenVerdict>) | undefined,
  end: (reason: string) => void,
  logFields: { id: string; clientId: string },
): GrantLifetime {
  let grantTimer: ReturnType<typeof setTimeout> | null = null
  const endAt = (expiresAt: number): void => {
    if (grantTimer) clearTimeout(grantTimer)
    grantTimer = setTimeout(() => {
      log.info('ws_session_grant_expired', logFields)
      end('grant expired')
    }, Math.max(0, expiresAt - Date.now()))
    grantTimer.unref?.()
  }
  const stop = (): void => { if (grantTimer) clearTimeout(grantTimer) }
  const expiresAt = principalExpiresAt(principal)
  if (expiresAt === null) return { renewAccess: undefined, stop }
  endAt(expiresAt)
  const renews = (principal.kind === 'owner' && principal.via === 'grant') || principal.kind === 'org-member'
  if (!verifyAccessToken || !renews) return { renewAccess: undefined, stop }
  const renewAccess = async (accessToken: string): Promise<number> => {
    const verdict = await verifyAccessToken(accessToken)
    const renewedAt = verdict.ok ? renewalExpiry(principal, verdict.claims) : null
    if (renewedAt === null) {
      log.info('ws_session_renewal_refused', { ...logFields, reason: verdict.ok ? 'other-standing' : verdict.reason })
      throw new Error('This token does not continue this connection.')
    }
    // The principal object is the one every call on this socket reads.
    principal.expiresAt = renewedAt
    endAt(renewedAt)
    return renewedAt
  }
  return { renewAccess, stop }
}

/** True for the host socket's path, with or without a trailing slash or query. */
export function isHostSocketPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0]
  return path === HOST_SOCKET_PATH || path === `${HOST_SOCKET_PATH}/`
}

/** One client frame, or null when the data is not one. */
function parseClientFrame(data: RawData): ClientFrame | null {
  try {
    const parsed = clientFrameSchema.safeParse(JSON.parse(data.toString()))
    return parsed.success ? parsed.data : null
  } catch {
    return null
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
      if (err instanceof TurnRefusedError || err instanceof PolicyRefusedError) return { error: { message: err.message, code: err.code } }
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
