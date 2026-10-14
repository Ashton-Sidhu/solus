import { SolusApiClient } from '@solus/contracts/solus-api/client'
import { workspaceRecordMethods } from './workspace-records'
import { io, type Socket } from 'socket.io-client'
import { RPC_INVOKE_METHODS } from '@solus/contracts/rpc'
import type { RpcInvokeMethod } from '@solus/contracts/rpc'
import type { IpcContext } from '@solus/contracts/types'
import type { SolusAPI } from '@solus/contracts/host-api'
import { HostEventSubscriber } from './host-event-subscriber'
import { HostGoneError, HostRpcError, TransportDisconnectedError } from './rpc-error'
import { BrowserFrameSubscriber } from './browser-frame-subscriber'
import { isHostEvent, type HostEvent } from '@solus/contracts/host-events'
import {
  encodePcm16Wav,
  MAX_VOICE_RECORDING_MINUTES,
  MAX_VOICE_SAMPLES,
} from '@solus/contracts/voice-audio'
import { z } from 'zod'
import { randomId } from './random-id'
import type { DialOutcome } from './host-supervisor'

/** WebSocket transport shared by the browser client, the Electron renderer,
 *  and the native mobile client. It holds no DOM behavior: the browser
 *  capabilities are added by `ws-browser-api.ts`. */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'blocked' | 'identity-mismatch'

// The error lives beside HostRpcError so modules that classify a failure do
// not load socket.io; existing importers keep this path.
export { HostGoneError, TransportDisconnectedError }

export interface WsTransportOptions {
  /** Server URL like `http://host:port`. */
  serverUrl: string
  /** Client-side identity of the host this transport addresses. */
  serverId?: string
  /** Session token returned from pairing or the desktop local bootstrap. Empty
   *  when the credential is minted per dial (an Uplink grant). */
  sessionToken: string
  /** An Uplink grant for the next dial. The host accepts a grant at every ticket
   *  exchange until it expires, so a source may hand back one it kept; `fresh`
   *  asks for a new one after the host refused a kept one. Null means no grant
   *  could be had right now (signed out, or the website did not answer). */
  acquireGrant?: (options?: { fresh?: boolean }) => Promise<string | null>
  /** Why `acquireGrant` last gave nothing, when the account plane refused it. A
   *  `lasting` refusal stands until something changes on the account side. */
  grantRefusal?: () => GrantRefusal | null
  /** A guest's link secret, presented with every grant: the host admits the pair
   *  to one resource (docs/plans/multiplayer-sharing.md §3.4). */
  shareSecret?: string
  /** A host-admitted guest (docs/plans/host-sharing.md §4.1): no grant, the secret
   *  alone with the id and name the visitor states. Set only with `shareSecret`. */
  guestIdentity?: { guestId: string; displayName: string }
  onStatusChange?: (status: ConnectionStatus, attempt: number) => void
  /** Called after /auth/refresh returns a fresh token. */
  onSessionTokenRefreshed?: (sessionToken: string) => void
  /** Called when the server rejects the stored token and refresh cannot recover. */
  onAuthFailed?: () => void
  /** Confirms that a newly opened socket is still the saved host it names. */
  verifyConnectedHost?: () => Promise<boolean>
  /** How a dial (or the standing socket) ended — the supervisor's input. The
   *  transport never schedules its own retries (dispatch-client step 3). */
  onDialOutcome?: (outcome: DialOutcome) => void
  /** Overrides the default POST to `${serverUrl}/auth/refresh`. */
  refreshToken?: () => Promise<{ result: RefreshResult; sessionToken?: string }>
  /** The organization the client works in, named in the record API's context
   *  key so a response for another organization is discarded. */
  organizationId?: () => string | null
  /** The organization a grant's connection works in, named at the ticket and the
   *  record API's credential exchange: a token that lists several organizations is
   *  admitted only in the one named (ADR 0001 §6.4). */
  dialOrganizationId?: () => string | null
  /** The signed-in person's access token for this host, for a socket that did not dial
   *  with it (a pairing, a trusted network, loopback): presented with `accountPresent`
   *  so the host keeps their delegation (ADR 0001 §6 item 5). Null when signed out, the
   *  host is not registered, or the account refused a token for it. */
  accountToken?: () => Promise<string | null>
}

/** A server request as Socket.IO delivers it: the payload, then the acknowledgement the server waits on. */
type ServerRequestListener = Parameters<Socket['on']>[1]

interface RequestEntry {
  method: RpcInvokeMethod
  args: unknown[]
  state: 'queued' | 'sent'
  resolve?: (value: RpcInvocationResult) => void
  reject?: (err: Error) => void
  queuedAt: number
  /** Boot work must survive arbitrarily slow first startup. */
  queuedBeforeFirstConnect: boolean
}

interface RpcResponse {
  result?: RpcInvocationResult
  error?: { message: string; code?: string }
}

// The ack envelope is wire input: parse it before touching `error`/`result`.
// Tolerant on purpose — an unreadable error message degrades to the generic
// one, and only a non-object ack fails the parse outright. The code is kept:
// a refusal a surface has to act on (`SEAT_REQUIRED`) is named by it.
const rpcResponseEnvelopeSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({
    message: z.string().optional().catch(undefined),
    code: z.string().optional().catch(undefined),
  }).optional().catch(undefined),
})

type RpcInvocationResult = Awaited<ReturnType<SolusAPI[RpcInvokeMethod]>>

/** How a dial's credential exchange ended. `unreachable` means the route did not
 *  answer at all, which the socket on the same route would only confirm later. */
/** The body of `POST /auth/ws-ticket`: the share secret, and the guest's own name when no grant names it. */
interface WsTicketRequest {
  organizationId?: string
  shareSecret?: string
  guestId?: string
  displayName?: string
}

interface TicketExchange {
  ticket: string | null
  unreachable: boolean
  /** The host answered 401: it does not take this credential. */
  refused: boolean
  /** The access token the ticket was exchanged for, when the credential was a grant. */
  grant?: string
  /** The account plane gave no grant for this host, and said why. */
  accountRefusal?: GrantRefusal
}

/** The account plane's refusal of a grant, as the transport acts on it. */
export interface GrantRefusal {
  lasting: boolean
  /** For the log: the refusal's code, rule, and description. */
  reason: string
}

/** Straight lasting refusals after which the transport stops dialing and reports the host blocked. */
export const LASTING_REFUSALS_BEFORE_BLOCK = 3

/** The work a dial needs besides the socket. It starts with the dial, so it runs
 *  while the WebSocket opens: socket.io asks for `auth` only after the open. */
interface DialPreparation {
  exchange: Promise<TicketExchange>
  identity: Promise<boolean>
}

const RECONNECT_QUEUE_MAX_AGE_MS = 15_000
/** A token-admitted socket sends its next access token this long before the current one ends (`authRenew`). */
export const GRANT_RENEWAL_LEAD_MS = 60_000
const WAKE_PROBE_TIMEOUT_MS = 5_000
const WAKE_PROBE_METHOD: RpcInvokeMethod = 'connectionsGetServerInfo'

export function shouldRejectQueuedRequest(
  queuedAt: number,
  queuedBeforeFirstConnect: boolean,
  now: number,
): boolean {
  return !queuedBeforeFirstConnect && now - queuedAt > RECONNECT_QUEUE_MAX_AGE_MS
}

export class WsTransport {
  readonly events = new HostEventSubscriber()
  /** Streamed browser frames for this host, routed by page id. Separate from
   *  `events`: binary bytes, not a typed-event envelope. */
  readonly frames = new BrowserFrameSubscriber()
  /** Native device video for this host, routed by device host and device. */
  private socket: Socket
  private readonly clientInstanceId = randomId()
  private nextId = 1
  private requests = new Map<string, RequestEntry>()
  private onResetCallback: (() => void) | null = null
  private status: ConnectionStatus = 'disconnected'
  private lastNotifiedAttempt = 0
  private attempt = 0
  private destroyed = false
  /** Why calls fail once this transport is destroyed. */
  private closedReason: TransportDisconnectedError = new TransportDisconnectedError()
  private blocked = false
  private hasOpened = false
  private authRefreshAttempted = false
  /** The last ticket exchange presented a fresh grant and the host answered 401. */
  private grantRefusedByHost = false
  /** Dials in a row the account plane refused a grant for, lastingly. */
  private lastingRefusals = 0
  private authRefreshResetTimer: ReturnType<typeof setTimeout> | null = null
  private wakeProbeInFlight = false
  private connectedGeneration = 0
  private isAcceptedConnection = false
  private pendingHostEvents: HostEvent[] = []
  private dialPreparation: DialPreparation | null = null
  /** Requests the server sends and waits on, by event; installed on every socket this transport opens. */
  private readonly serverRequests = new Map<string, ServerRequestListener>()
  /** Sends the socket's next access token before the current one ends (docs/adr/0001-standard-authentication.md rule 4). */
  private grantRenewalTimer: ReturnType<typeof setTimeout> | null = null
  /** Presents the person's account token again before the presented one ends (`accountPresent`). */
  private accountPresentationTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private opts: WsTransportOptions) {
    this.socket = this.createSocket()
    this.installSocketListeners()
  }

  private createSocket(): Socket {
    return io(this.opts.serverUrl, {
      path: '/ws',
      transports: ['websocket'],
      // The supervisor is the sole retry owner; the socket dials only when told.
      reconnection: false,
      autoConnect: false,
      // The long-lived credential travels only in HTTP headers. A failed
      // exchange dials without a credential, so an authenticated host rejects
      // the socket and the normal refresh path decides whether to retry.
      auth: (cb) => {
        void (this.dialPreparation?.exchange ?? this.fetchWsTicket()).then(({ ticket }) => {
          cb(ticket
            ? { ticket, clientInstanceId: this.clientInstanceId }
            : { clientInstanceId: this.clientInstanceId })
        })
      },
    })
  }

  get serverUrl(): string {
    return this.opts.serverUrl
  }

  /**
   * Re-aims the standing socket at another route to the same host (direct-first
   * dialing, C3). Queued requests and event subscribers stay; only the socket is
   * replaced. The supervisor dials the new socket on its next `start()`.
   */
  switchServerUrl(serverUrl: string): void {
    if (this.destroyed || serverUrl === this.opts.serverUrl) return
    this.logConnection('switching route', { from: this.opts.serverUrl, to: serverUrl })
    this.socket.removeAllListeners()
    this.socket.disconnect()
    this.cancelGrantRenewal()
    this.cancelAccountPresentation()
    this.connectedGeneration += 1
    this.isAcceptedConnection = false
    this.dialPreparation = null
    this.requeueSentRequests()
    this.opts.serverUrl = serverUrl
    this.socket = this.createSocket()
    this.installSocketListeners()
  }

  /** Answers one kind of request the server sends down this socket and waits on
   *  (the Solus API's shared prompts to a runner). The payload is wire input: one
   *  the schema refuses is answered with `unreadable`, and the handler never runs. */
  onServerRequest<Payload, Reply>(event: string, payload: z.ZodType<Payload>, handle: (payload: Payload) => Promise<Reply>, unreadable: Reply): () => void {
    const listener: ServerRequestListener = (wire, reply) => {
      const parsed = payload.safeParse(wire)
      if (!parsed.success) { reply(unreadable); return }
      void handle(parsed.data).then(reply)
    }
    this.serverRequests.set(event, listener)
    this.socket.on(event, listener)
    return () => {
      if (this.serverRequests.get(event) !== listener) return
      this.serverRequests.delete(event)
      this.socket.off(event, listener)
    }
  }

  start(): void {
    if (this.destroyed) return
    if (this.blocked) {
      this.blocked = false
      this.authRefreshAttempted = false
      this.lastingRefusals = 0
      this.attempt = 0
    }
    if (!this.socket.connected) {
      this.setStatus(this.hasOpened ? 'reconnecting' : 'connecting')
      this.dialSocket()
    }
  }

  /** One dial: the credential exchange and the identity check start now, beside
   *  the socket open, instead of one after the other once it is open. */
  private dialSocket(): void {
    const preparation: DialPreparation = {
      exchange: this.fetchWsTicket(),
      identity: this.opts.verifyConnectedHost?.().catch(() => false) ?? Promise.resolve(true),
    }
    this.dialPreparation = preparation
    void preparation.exchange.then(({ unreachable, accountRefusal }) => {
      if (accountRefusal) {
        this.refuseDial(preparation, accountRefusal)
        return
      }
      if (!unreachable || this.dialPreparation !== preparation) return
      if (this.destroyed || this.blocked || this.socket.connected) return
      // The route did not answer: the socket on it will not open either, and
      // socket.io would wait out its 20s connect timeout to say so. Fail the dial
      // now so the supervisor can move to the host's next route.
      this.dialPreparation = null
      this.socket.disconnect()
      this.logConnection('route unreachable', { serverUrl: this.opts.serverUrl })
      this.opts.onDialOutcome?.({ kind: 'dial-failed' })
    })
    this.socket.connect()
  }

  /**
   * The account plane gave no grant for this host: the socket could only be refused
   * as `unauthorized`, so it is not opened. The refusal is logged with its reason; one
   * that keeps coming back the same way blocks the host until the person retries.
   */
  private refuseDial(preparation: DialPreparation, refusal: GrantRefusal): void {
    if (this.dialPreparation !== preparation) return
    if (this.destroyed || this.blocked || this.socket.connected) return
    this.dialPreparation = null
    this.socket.disconnect()
    this.lastingRefusals = refusal.lasting ? this.lastingRefusals + 1 : 0
    const blocks = this.lastingRefusals >= LASTING_REFUSALS_BEFORE_BLOCK
    console.warn('[solus:ws] account refused a grant for this host', {
      clientInstanceId: this.clientInstanceId,
      serverId: this.opts.serverId ?? null,
      reason: refusal.reason,
      lasting: refusal.lasting,
      refusals: this.lastingRefusals,
      blocks,
    })
    if (blocks) this.blockAuthFailure()
    else this.opts.onDialOutcome?.({ kind: 'dial-failed' })
  }

  /** Close for good. Every queued and later call rejects with `reason`. */
  destroy(finalStatus: ConnectionStatus = 'disconnected', reason = new TransportDisconnectedError()): void {
    if (this.destroyed) return
    this.destroyed = true
    this.closedReason = reason
    this.cancelGrantRenewal()
    this.cancelAccountPresentation()
    if (this.authRefreshResetTimer) clearTimeout(this.authRefreshResetTimer)
    this.authRefreshResetTimer = null
    this.socket.disconnect()
    this.rejectAllRequests()
    this.events.clear()
    this.pendingHostEvents = []
    this.onResetCallback = null
    this.setStatus(finalStatus)
  }

  get serverId(): string | undefined {
    return this.opts.serverId
  }

  /** Builds the host's RPC and record API on this transport. It has no client
   *  window behavior; a browser adds that with `withBrowserCapabilities`. */
  buildSolusApi() {
    const api = {}

    for (const method of RPC_INVOKE_METHODS) {
      // SAFETY: each generated method forwards its caller's arguments verbatim;
      // the caller typed them against this same method's SolusAPI signature.
      Reflect.set(api, method, (...args: unknown[]) => this.invoke(method, args as Parameters<SolusAPI[typeof method]>))
    }

    // Encode PCM as compact WAV before transport. Direct connections upload
    // over HTTP; cloud connections use the host's base64 WAV RPC contract.
    Reflect.set(api, 'transcribeAudio', (audio: Float32Array | string, ctx?: IpcContext) =>
      audio instanceof Float32Array
        ? this.transcribeAudio(audio, ctx)
        : this.invoke('transcribeAudio', [audio, ctx]))

    const records = workspaceRecordMethods(new SolusApiClient({
      baseUrl: () => this.opts.serverUrl,
      contextKey: () => JSON.stringify([this.opts.serverId, this.opts.organizationId?.() ?? null]),
      organizationId: () => this.opts.acquireGrant ? this.opts.dialOrganizationId?.() ?? null : null,
      acquireSource: async () => {
        if (this.opts.acquireGrant) return this.opts.acquireGrant()
        // A link guest presents the secret alone, as at the ticket door.
        if (this.opts.guestIdentity) return null
        await this.refreshToken()
        return this.opts.sessionToken
      },
      shareSecret: this.opts.shareSecret,
      guestIdentity: this.opts.guestIdentity,
    }), id => this.invoke('tasksReadExtras', [id]))
    return Object.assign(api, records)
  }

  onReset(callback: () => void): () => void {
    this.onResetCallback = callback
    return () => { if (this.onResetCallback === callback) this.onResetCallback = null }
  }

  /** Late-bound: the supervisor exists only after the transport it drives. */
  attachDialOutcomeReporter(report: (outcome: DialOutcome) => void): void {
    this.opts.onDialOutcome = report
  }

  /** Exchange the bearer credential for one dial's handshake ticket. Null
   *  means the handshake is credential-free; only a trusted requester or a
   *  host configured without auth can admit it. */
  private async fetchWsTicket(): Promise<TicketExchange> {
    this.grantRefusedByHost = false
    const { acquireGrant } = this.opts
    if (!acquireGrant) return this.exchangeForTicket(this.opts.guestIdentity ? null : this.opts.sessionToken)
    const grant = await acquireGrant().catch(() => null)
    const accountRefusal = grant ? null : this.opts.grantRefusal?.() ?? null
    if (accountRefusal) return { ticket: null, unreachable: false, refused: false, accountRefusal }
    const exchange = await this.exchangeForTicket(grant)
    if (!exchange.refused) return { ...exchange, grant: grant ?? undefined }
    // A kept grant can outlive the host's trust in it, as when the host was linked
    // again since. Only a new grant the host refuses means this device is done here.
    const fresh = await acquireGrant({ fresh: true }).catch(() => null)
    const retry = await this.exchangeForTicket(fresh)
    this.grantRefusedByHost = retry.refused
    return { ...retry, grant: fresh ?? undefined }
  }

  /**
   * Plans the next `authRenew` for the token this socket was admitted or renewed
   * with: a little before it ends, the same grant source gives the next token, and the
   * host moves the socket's end to it. A token whose end cannot be read, a host that
   * refuses, or a source that has none leaves the socket to end at its expiry; the
   * supervisor then dials again as for any drop.
   */
  private scheduleGrantRenewal(grant: string | undefined, generation: number): void {
    this.cancelGrantRenewal()
    const endsAt = grant ? accessTokenEndsAt(grant) : null
    if (!grant || endsAt === null || !this.opts.acquireGrant) return
    this.grantRenewalTimer = setTimeout(() => {
      this.grantRenewalTimer = null
      void this.renewGrant(grant, generation)
    }, Math.max(0, endsAt - GRANT_RENEWAL_LEAD_MS - Date.now()))
  }

  private cancelGrantRenewal(): void {
    if (this.grantRenewalTimer) clearTimeout(this.grantRenewalTimer)
    this.grantRenewalTimer = null
  }

  private cancelAccountPresentation(): void {
    if (this.accountPresentationTimer) clearTimeout(this.accountPresentationTimer)
    this.accountPresentationTimer = null
  }

  /**
   * A socket that did not dial with the person's account token presents it
   * (`accountPresent`), on connect and again a little before each presented token
   * ends, so the host holds their delegation while this client is connected (ADR 0001
   * §6 item 5). No token (signed out, the host not registered, the account refused)
   * or a host that refuses the call stops it until the next connection.
   */
  private async presentAccount(generation: number): Promise<void> {
    const accountToken = this.opts.accountToken
    if (!accountToken) return
    const token = await accountToken().catch(() => null)
    if (!token || generation !== this.connectedGeneration) return
    try {
      await this.invoke('accountPresent', [{ accessToken: token }])
    } catch (error) {
      this.logConnection('account presentation refused', { message: error instanceof Error ? error.message : String(error) })
      return
    }
    const endsAt = accessTokenEndsAt(token)
    if (endsAt === null || generation !== this.connectedGeneration) return
    this.accountPresentationTimer = setTimeout(() => {
      this.accountPresentationTimer = null
      void this.presentAccount(generation)
    }, Math.max(0, endsAt - GRANT_RENEWAL_LEAD_MS - Date.now()))
  }

  private async renewGrant(current: string, generation: number): Promise<void> {
    const acquireGrant = this.opts.acquireGrant
    if (!acquireGrant) return
    let next = await acquireGrant().catch(() => null)
    // A source that keeps tokens may hand back the one in use; ask it for a new one.
    if (next === current) next = await acquireGrant({ fresh: true }).catch(() => null)
    if (!next || next === current || generation !== this.connectedGeneration) return
    try {
      await this.invoke('authRenew', [{ accessToken: next }])
      if (generation === this.connectedGeneration) this.scheduleGrantRenewal(next, generation)
    } catch (error) {
      this.logConnection('grant renewal refused', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async exchangeForTicket(credential: string | null): Promise<TicketExchange> {
    const { shareSecret, guestIdentity } = this.opts
    if (!credential && !(shareSecret && guestIdentity)) return { ticket: null, unreachable: false, refused: false }
    const headers: Record<string, string> = {}
    if (credential) headers.authorization = `Bearer ${credential}`
    // With a grant, the grant names the guest; without one, the guest names itself.
    const request: WsTicketRequest = {}
    const organizationId = credential && this.opts.acquireGrant ? this.opts.dialOrganizationId?.() : null
    if (organizationId) request.organizationId = organizationId
    if (shareSecret) request.shareSecret = shareSecret
    if (shareSecret && !credential && guestIdentity) {
      request.guestId = guestIdentity.guestId
      request.displayName = guestIdentity.displayName
    }
    const hasBody = Object.keys(request).length > 0
    if (hasBody) headers['content-type'] = 'application/json'
    try {
      const response = await fetch(`${this.opts.serverUrl}/auth/ws-ticket`, {
        method: 'POST',
        headers,
        body: hasBody ? JSON.stringify(request) : undefined,
        signal: AbortSignal.timeout(3_000),
      })
      if (!response.ok) return { ticket: null, unreachable: false, refused: response.status === 401 }
      const body = z.object({ ticket: z.string().min(1).optional().catch(undefined) })
        .catch({})
        .parse(await response.json().catch(() => ({})))
      return { ticket: body.ticket ?? null, unreachable: false, refused: false }
    } catch {
      // The route allows any origin here, so a failed fetch is a route that did not answer.
      return { ticket: null, unreachable: true, refused: false }
    }
  }

  private installSocketListeners(): void {
    for (const [event, listener] of this.serverRequests) this.socket.on(event, listener)
    this.socket.on('connect', () => {
      const generation = ++this.connectedGeneration
      void this.acceptConnectedSocket(generation)
    })
    this.socket.on('disconnect', (reason) => {
      this.cancelGrantRenewal()
      this.cancelAccountPresentation()
      this.connectedGeneration += 1
      this.isAcceptedConnection = false
      this.pendingHostEvents = []
      this.logConnection('socket closed', { reason, pendingRequests: this.pendingRequestSummary() })
      this.requeueSentRequests()
      if (this.destroyed || this.blocked) return
      this.setStatus('reconnecting')
      this.opts.onDialOutcome?.({ kind: 'dropped' })
    })
    this.socket.on('connect_error', (error: Error & { data?: { code?: string } }) => {
      this.logConnection('socket connection error', { message: error.message, code: error.data?.code ?? null })
      if (error.data?.code !== 'UNAUTHORIZED') {
        // With auto-reconnection off nobody else will ever dial again: the
        // failed dial is the supervisor's cue to schedule the next one.
        if (!this.destroyed && !this.blocked) this.opts.onDialOutcome?.({ kind: 'dial-failed' })
        return
      }
      if (this.opts.acquireGrant) {
        // There is no token to refresh: the next dial mints its own grant. Only a
        // grant the host itself refused means this device is done here.
        if (this.grantRefusedByHost) this.blockAuthFailure()
        else if (!this.destroyed && !this.blocked) this.opts.onDialOutcome?.({ kind: 'dial-failed' })
        return
      }
      if (this.authRefreshAttempted) {
        this.blockAuthFailure()
        return
      }
      this.authRefreshAttempted = true
      void this.recoverAuthentication()
    })
    this.socket.on('host-event', (event) => {
      if (!isHostEvent(event)) return
      if (this.isAcceptedConnection) this.events.receive(event)
      else this.pendingHostEvents.push(event)
    })
    // Frames are not buffered pre-accept the way events are: a frame is a moving
    // picture, so a stale one held through a reconnect is worse than a dropped
    // one. The host only streams to a subscribed client anyway, and subscribing
    // needs a live connection, so frames arrive only once accepted.
    this.socket.on('browser-frame', (header, data) => {
      if (this.isAcceptedConnection) this.frames.receive(header, data)
    })
  }

  private async acceptConnectedSocket(generation: number): Promise<void> {
    const identity = this.dialPreparation?.identity
      ?? this.opts.verifyConnectedHost?.().catch(() => false)
      ?? Promise.resolve(true)
    const exchange = this.dialPreparation?.exchange
    this.dialPreparation = null
    const accepted = await identity
    if (this.destroyed || generation !== this.connectedGeneration || !this.socket.connected) return
    if (!accepted) {
      this.destroy('identity-mismatch')
      this.opts.onDialOutcome?.({ kind: 'identity-mismatch' })
      return
    }

    this.isAcceptedConnection = true
    for (const event of this.pendingHostEvents.splice(0)) this.events.receive(event)
    const shouldReset = this.hasOpened && !this.socket.recovered
    this.hasOpened = true
    this.attempt = 0
    this.setStatus('connected')
    this.logConnection('socket opened', {
      recovered: this.socket.recovered,
      pendingRequests: this.pendingRequestSummary(),
    })
    if (shouldReset) this.onResetCallback?.()
    this.lastingRefusals = 0
    this.opts.onDialOutcome?.({ kind: 'accepted', recovered: this.socket.recovered })
    this.flushQueuedRequests()
    if (exchange) void exchange.then(({ grant }) => this.scheduleGrantRenewal(grant, generation))
    if (!this.opts.acquireGrant) void this.presentAccount(generation)
    if (this.authRefreshAttempted) {
      if (this.authRefreshResetTimer) clearTimeout(this.authRefreshResetTimer)
      this.authRefreshResetTimer = setTimeout(() => { this.authRefreshAttempted = false }, 30_000)
    }
  }

  private async recoverAuthentication(): Promise<void> {
    let refreshResult: RefreshResult = 'unavailable'
    try { refreshResult = await this.refreshToken() } catch {}
    if (this.destroyed) return
    if (refreshResult !== 'refreshed') {
      this.blockAuthFailure()
      return
    }
    this.setStatus(this.hasOpened ? 'reconnecting' : 'connecting')
    this.dialSocket()
  }

  private async transcribeAudio(samples: Float32Array, ctx?: IpcContext): Promise<{ error: string | null; transcript: string | null }> {
    if (samples.length > MAX_VOICE_SAMPLES) {
      return {
        error: `Voice recordings can be up to ${MAX_VOICE_RECORDING_MINUTES} minutes long.`,
        transcript: null,
      }
    }

    const wav = encodePcm16Wav(samples)
    if (this.opts.acquireGrant) {
      // The cloud tunnel carries authenticated RPC, but has no HTTP upload
      // route. Encode in small multiples of three bytes so only the final
      // base64 chunk has padding, without spreading a whole recording.
      const bytes = new Uint8Array(wav)
      const chunks: string[] = []
      const chunkSize = 24_576
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))))
      }
      return this.invoke('transcribeAudio', [chunks.join(''), ctx])
    }
    let response = await this.postVoiceRecording(wav)
    if (response.status === 401 && await this.refreshToken() === 'refreshed') {
      response = await this.postVoiceRecording(wav)
    }

    const bodySchema = z.object({
      error: z.string().nullable().optional(),
      transcript: z.string().nullable().optional(),
    })
    let body: z.infer<typeof bodySchema> = {}
    try {
      const parsed = bodySchema.safeParse(await response.json())
      if (parsed.success) body = parsed.data
    } catch {}
    if (!response.ok) {
      return { error: body.error || `Voice upload failed (${response.status})`, transcript: null }
    }
    return {
      error: body.error ?? null,
      transcript: body.transcript ?? null,
    }
  }

  private postVoiceRecording(wav: ArrayBuffer): Promise<Response> {
    const headers = { 'content-type': 'audio/wav' }
    if (this.opts.sessionToken) Object.assign(headers, { authorization: `Bearer ${this.opts.sessionToken}` })
    return fetch(`${this.opts.serverUrl}/voice/transcribe`, {
      method: 'POST',
      headers,
      body: wav,
    })
  }

  /** One typed RPC call, queued until the socket is accepted. */
  invoke<M extends RpcInvokeMethod>(method: M, args: Parameters<SolusAPI[M]>): Promise<Awaited<ReturnType<SolusAPI[M]>>> {
    if (this.destroyed) return Promise.reject(this.closedReason)
    if (this.blocked) return Promise.reject(new TransportDisconnectedError())
    const id = String(this.nextId++)
    return new Promise<Awaited<ReturnType<SolusAPI[M]>>>((resolve, reject) => {
      const entry: RequestEntry = {
        method,
        args,
        state: 'queued',
        // SAFETY: This request keeps the resolver with the same method whose result type parameterized it.
        resolve: resolve as (value: RpcInvocationResult) => void,
        reject,
        queuedAt: Date.now(),
        queuedBeforeFirstConnect: !this.hasOpened,
      }
      this.requests.set(id, entry)
      if (this.socket.connected) this.sendRequest(id, entry)
    })
  }

  private flushQueuedRequests(): void {
    const now = Date.now()
    for (const [id, request] of this.requests) {
      if (request.state !== 'queued') continue
      if (shouldRejectQueuedRequest(request.queuedAt, request.queuedBeforeFirstConnect, now)) {
        this.requests.delete(id)
        request.reject?.(new TransportDisconnectedError())
        continue
      }
      this.sendRequest(id, request)
    }
  }

  private sendRequest(id: string, request: RequestEntry): void {
    request.state = 'sent'
    this.socket.emit('rpc', id, request.method, request.args, (response: RpcResponse) => {
      const current = this.requests.get(id)
      if (!current) return
      this.requests.delete(id)
      // This ack runs inside socket.io's packet loop: a malformed ack must
      // settle this one request as a failed call, never throw into the
      // transport or leave a hung promise replayed on every reconnect.
      const envelope = rpcResponseEnvelopeSchema.safeParse(response)
      if (!envelope.success) {
        current.reject?.(new Error(`rpc ack for ${request.method} was malformed`))
        return
      }
      if (envelope.data.error) {
        current.reject?.(new HostRpcError(envelope.data.error.message ?? 'rpc error', envelope.data.error.code))
      } else {
        // SAFETY: The result carries the invoked method's return type, which
        // the wire cannot prove and callers' TS types already assumed pre-parse.
        current.resolve?.(envelope.data.result as RpcInvocationResult)
      }
    })
  }

  private requeueSentRequests(): void {
    const queuedAt = Date.now()
    for (const request of this.requests.values()) {
      if (request.state !== 'sent') continue
      request.state = 'queued'
      request.queuedAt = queuedAt
      request.queuedBeforeFirstConnect = false
    }
  }

  private rejectAllRequests(): void {
    const error = this.destroyed ? this.closedReason : new TransportDisconnectedError()
    for (const request of this.requests.values()) request.reject?.(error)
    this.requests.clear()
  }

  private async refreshToken(): Promise<RefreshResult> {
    const refreshed = this.opts.refreshToken
      ? await this.opts.refreshToken()
      : await refreshSessionToken(this.opts.serverUrl, this.opts.sessionToken)
    if (refreshed.result !== 'refreshed' || !refreshed.sessionToken) return refreshed.result === 'refreshed' ? 'unavailable' : refreshed.result
    this.opts.sessionToken = refreshed.sessionToken
    this.opts.onSessionTokenRefreshed?.(refreshed.sessionToken)
    return 'refreshed'
  }

  private blockAuthFailure(): void {
    if (this.blocked) return
    this.blocked = true
    this.socket.disconnect()
    this.setStatus('blocked')
    this.rejectAllRequests()
    this.opts.onDialOutcome?.({ kind: 'auth-blocked' })
    this.opts.onAuthFailed?.()
  }

  /**
   * Abandons the current backoff and dials immediately. A user who just fixed
   * the network should not wait out a 30s timer they cannot see. No-op while
   * blocked: an auth failure needs re-pairing, not another dial.
   */
  reconnectNow(): void {
    if (this.destroyed || this.blocked) return
    this.socket.disconnect()
    this.setStatus(this.hasOpened ? 'reconnecting' : 'connecting')
    this.dialSocket()
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status && this.lastNotifiedAttempt === this.attempt) return
    this.status = status
    this.lastNotifiedAttempt = this.attempt
    this.opts.onStatusChange?.(status, this.attempt)
  }

  private pendingRequestSummary(): Array<{ id: string; method: RpcInvokeMethod; state: RequestEntry['state']; ageMs: number }> {
    const now = Date.now()
    return [...this.requests].map(([id, request]) => ({
      id,
      method: request.method,
      state: request.state,
      ageMs: now - request.queuedAt,
    }))
  }

  private logConnection<Data extends object>(message: string, data: Data): void {
    console.info(`[solus:ws] ${message}`, {
      clientInstanceId: this.clientInstanceId,
      status: this.status,
      ...data,
    })
  }

  /** Asks the connected socket to prove it is alive. Rejection is a report,
   *  not an action — the supervisor decides what a failed probe means. The
   *  stale socket is hung up first so the supervisor's next dial is fresh. */
  async probe(): Promise<void> {
    if (this.destroyed || this.blocked || this.wakeProbeInFlight) return
    if (!this.socket.connected) {
      throw new Error('socket is not connected')
    }
    this.wakeProbeInFlight = true
    try {
      await withTimeout(this.invoke(WAKE_PROBE_METHOD, []), WAKE_PROBE_TIMEOUT_MS)
    } catch (error) {
      this.socket.disconnect()
      throw error
    } finally {
      this.wakeProbeInFlight = false
    }
  }
}

export type RefreshResult = 'refreshed' | 'fresh' | 'unauthorized' | 'unavailable'

async function refreshSessionToken(serverUrl: string, sessionToken: string): Promise<{ result: RefreshResult; sessionToken?: string }> {
  try {
    const res = await fetch(`${serverUrl}/auth/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionToken}` },
    })
    if (res.status === 401) return { result: 'unauthorized' }
    if (!res.ok) return { result: 'unavailable' }
    const body = z.object({ sessionToken: z.string().optional() }).safeParse(await res.json())
    return body.success && body.data.sessionToken
      ? { result: 'refreshed', sessionToken: body.data.sessionToken }
      : { result: 'unavailable' }
  } catch {
    return { result: 'unavailable' }
  }
}

const accessTokenEndSchema = z.object({ exp: z.number() })

/** When a JWT access token ends (ms), read from its `exp`; null when the token is not a JWT with one. */
export function accessTokenEndsAt(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='))
    const claims = accessTokenEndSchema.safeParse(JSON.parse(json))
    return claims.success ? claims.data.exp * 1000 : null
  } catch {
    return null
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}
