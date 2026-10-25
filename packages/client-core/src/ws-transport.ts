import { SolusApiClient } from '@solus/contracts/solus-api/client'
import { workspaceRecordMethods } from './workspace-records'
import { io, type Socket } from 'socket.io-client'
import { RPC_INVOKE_METHODS } from '@solus/contracts/rpc'
import type { RpcInvokeMethod } from '@solus/contracts/rpc'
import type { IpcContext } from '@solus/contracts/types'
import type { SolusAPI } from '@solus/contracts/host-api'
import { HostEventSubscriber } from './host-event-subscriber'
import { HostGoneError, HostRpcError, HostUnreachableError, TransportDisconnectedError } from './rpc-error'
import { BrowserFrameSubscriber } from './browser-frame-subscriber'
import { isHostEvent, type HostEvent } from '@solus/contracts/host-events'
import {
  encodePcm16Wav,
  MAX_VOICE_RECORDING_MINUTES,
  MAX_VOICE_SAMPLES,
} from '@solus/contracts/voice-audio'
import { z } from 'zod'
import { randomId } from './random-id'
import type { DialError } from './host-diagnostics'
import type { DialOutcome } from './host-supervisor'
import { type HandshakeCredential, type SocketHandshake } from '@solus/contracts/uplink'

/** WebSocket transport shared by the browser client, the Electron renderer,
 *  and the native mobile client. It holds no DOM behavior: the browser
 *  capabilities are added by `ws-browser-api.ts`. */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'blocked' | 'identity-mismatch'

// The error lives beside HostRpcError so modules that classify a failure do
// not load socket.io; existing importers keep this path.
export { HostGoneError, HostUnreachableError, TransportDisconnectedError }

export interface WsTransportOptions {
  /** Server URL like `http://host:port`. */
  serverUrl: string
  /** Client-side identity of the host this transport addresses. */
  serverId?: string
  /** Session token returned from pairing or the desktop local bootstrap. Empty
   *  when the credential is an access token or a share secret. */
  sessionToken: string
  /** Where each dial's access token comes from, for a host reached with one instead of a session token. */
  grants?: GrantSource
  /** A guest of a share link (docs/plans/host-sharing.md §4.1): the secret, with the
   *  id and name the visitor states, is the dial's one credential. */
  guest?: GuestCredential
  onStatusChange?: (status: ConnectionStatus, attempt: number) => void
  /** Called after /auth/refresh returns a fresh token. */
  onSessionTokenRefreshed?: (sessionToken: string) => void
  /** Called when the server rejects the stored token and refresh cannot recover. */
  onAuthFailed?: () => void
  /** Confirms that a newly opened socket is still the saved host it names. */
  verifyConnectedHost?: () => Promise<boolean>
  /**
   * The proof of the host a dial on `serverUrl` needs before its credential goes
   * (docs/plans/host-routes.md D3); null when the route needs none. A dial whose
   * route `chooseRoute` just proved (`hostConfirmed`) does not ask again.
   */
  proveRoute?: (serverUrl: string) => Promise<boolean> | null
  /** How a dial (or the standing socket) ended — the supervisor's input. The
   *  transport never schedules its own retries (dispatch-client step 3). */
  onDialOutcome?: (outcome: DialOutcome) => void
  /** Overrides the default POST to `${serverUrl}/auth/refresh`. */
  refreshToken?: () => Promise<{ result: RefreshResult; sessionToken?: string }>
  /** The organization the client works in, named in the record API's context
   *  key so a response for another organization is discarded. */
  organizationId?: () => string | null
  /** The organization a grant's connection works in, named in the handshake: a token
   *  that lists several organizations is admitted only in the one named (ADR 0001 §6.4). */
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

/** A guest's one credential: the link secret, with the id its page keeps and the name it typed. */
export interface GuestCredential {
  shareSecret: string
  guestId: string
  displayName: string
}

/** The credential one dial presents in its handshake, or why a dial with a grant source has none. */
type DialCredential =
  | { kind: 'present'; credential: HandshakeCredential | undefined }
  /** No token to present: the socket is not opened, since the host could only refuse it. */
  | { kind: 'missing'; missing: MissingGrant }

/**
 * The access tokens of a host reached with the account. The host takes a token in the
 * socket handshake until it expires, so a source may hand back one it kept; `refused`
 * names a kept token the host refused, which the source then does not give again.
 */
export interface GrantSource {
  /** Null when no token can be had now: see `refusal` and `isSignedOut` for why. */
  acquire(options?: { refused?: string }): Promise<string | null>
  /** Why `acquire` last gave nothing, when the account plane refused it. A `lasting`
   *  refusal stands until something changes on the account side. */
  refusal?(): GrantRefusal | null
  /** True when the account holds no sign-in: it ended or was never made. The host is
   *  then blocked until the person signs in again. */
  isSignedOut(): boolean
  /**
   * What the token is. An account's access token by default; a host that reaches
   * another host with a session token that host issued (an introduction or an SSH
   * add) says `session-token`, because the host admits each kind by its own rule.
   */
  tokenKind?: 'access-token' | 'session-token'
}

type MissingGrant =
  | { kind: 'refused'; refusal: GrantRefusal }
  | { kind: 'signed-out' }
  /** The account plane did not answer: retry on the supervisor's backoff. */
  | { kind: 'unanswered' }

/** The account plane's refusal of a grant, as the transport acts on it. */
export interface GrantRefusal {
  lasting: boolean
  /** For the log: the refusal's code, rule, and description. */
  reason: string
}

/**
 * How long a socket may take to open before its route counts as not answering. Route
 * choice (`chooseRoute`) already found a route that answers, so a slow open is a route
 * that stopped answering since, not one to wait out socket.io's 20 s for.
 */
export const SOCKET_CONNECT_TIMEOUT_MS = 5_000

/** The work a dial needs besides the socket. It starts with the dial, so it runs
 *  while the WebSocket opens: socket.io asks for `auth` only after the open. */
interface DialPreparation {
  credential: Promise<DialCredential>
  identity: Promise<boolean>
  /** False when the route needed a proof of the host and did not give one: the handshake then carries no credential. */
  proven: Promise<boolean>
}

/** When each part of one dial finished, in ms from its start: the `connection attempt` log line. */
interface DialTiming {
  startedAt: number
  serverUrl: string
  credentialMs?: number
  identityMs?: number
  socketOpenMs?: number
}

export type DialAttemptOutcome = 'connected' | 'failed'

/** A socket presents its next access token this long before the current one ends (`authRenew`, `accountPresent`). */
export const GRANT_RENEWAL_LEAD_MS = 60_000
const WAKE_PROBE_TIMEOUT_MS = 5_000
/** A refresh that does not answer is `unavailable`, never a dial that hangs. */
const REFRESH_TIMEOUT_MS = 10_000
const WAKE_PROBE_METHOD: RpcInvokeMethod = 'connectionsGetServerInfo'

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
  /** The supervisor says the host is unreachable: calls fail at once (docs/plans/host-readiness.md). */
  private unreachable = false
  /** How the last dial failed, for the host's diagnostics; cleared when a dial is accepted. */
  private dialError: DialError | null = null
  private hasOpened = false
  private authRefreshAttempted = false
  /** The access token the host last refused: the next dial asks the source for another. */
  private refusedGrant: string | null = null
  private authRefreshResetTimer: ReturnType<typeof setTimeout> | null = null
  private wakeProbeInFlight = false
  /** When this socket last received anything: a packet or the host's heartbeat. */
  private lastInboundAt = 0
  private connectedGeneration = 0
  private isAcceptedConnection = false
  private pendingHostEvents: HostEvent[] = []
  private dialPreparation: DialPreparation | null = null
  private dialTiming: DialTiming | null = null
  /** Requests the server sends and waits on, by event; installed on every socket this transport opens. */
  private readonly serverRequests = new Map<string, ServerRequestListener>()
  /** Presents the socket's next token before the current one ends (`presentToken`). */
  private presentationTimer: ReturnType<typeof setTimeout> | null = null

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
      timeout: SOCKET_CONNECT_TIMEOUT_MS,
      // The dial's one credential rides the handshake (docs/plans/simplify-auth-and-sync.md
      // §3 rule 4), with the protocol this client speaks.
      auth: (cb) => {
        const preparation = this.dialPreparation
        const proven = preparation?.proven ?? this.opts.proveRoute?.(this.opts.serverUrl) ?? Promise.resolve(true)
        void Promise.all([preparation?.credential ?? this.dialCredential(), proven.catch(() => false)]).then(([dial, isProven]) => {
          const handshake: SocketHandshake = { clientInstanceId: this.clientInstanceId }
          if (isProven && dial.kind === 'present' && dial.credential) handshake.credential = dial.credential
          cb(handshake)
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
    this.cancelPresentation()
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

  /**
   * One dial on the standing socket. `hostConfirmed` says the route just answered
   * `/health` as this host (`chooseRoute`), so the dial does not ask it again.
   */
  start(options: { hostConfirmed?: boolean } = {}): void {
    if (this.destroyed) return
    if (this.blocked) {
      this.blocked = false
      this.authRefreshAttempted = false
      this.attempt = 0
    }
    if (!this.socket.connected) {
      this.setStatus(this.hasOpened ? 'reconnecting' : 'connecting')
      this.dialSocket(options.hostConfirmed ?? false)
    }
  }

  /** One dial: the credential and the identity check start now, beside the socket open. */
  private dialSocket(hostConfirmed = false): void {
    const timing: DialTiming = { startedAt: Date.now(), serverUrl: this.opts.serverUrl }
    this.dialTiming = timing
    const proof = hostConfirmed ? null : this.opts.proveRoute?.(this.opts.serverUrl)?.catch(() => false) ?? null
    const preparation: DialPreparation = {
      credential: this.dialCredential(),
      // A proof of the host is also the identity check: it names the installation it signs for.
      identity: proof ?? (hostConfirmed ? Promise.resolve(true) : this.opts.verifyConnectedHost?.().catch(() => false) ?? Promise.resolve(true)),
      proven: proof ?? Promise.resolve(true),
    }
    this.dialPreparation = preparation
    void preparation.credential.then((dial) => {
      timing.credentialMs = Date.now() - timing.startedAt
      if (dial.kind === 'missing') this.refuseDial(preparation, dial.missing)
    })
    void preparation.identity.then(() => { timing.identityMs = Date.now() - timing.startedAt })
    this.socket.connect()
  }

  /**
   * The dial has no token to present: the socket could only be refused as
   * `unauthorized`, so it is not opened. An account with no sign-in blocks the host
   * until the person signs in again. An account refusal is logged with its reason; a
   * lasting one blocks the host until the person retries. An account plane that did
   * not answer, or a refusal that may pass, is retried like a route that did not.
   */
  private refuseDial(preparation: DialPreparation, missing: MissingGrant): void {
    if (this.dialPreparation !== preparation) return
    if (this.destroyed || this.blocked || this.socket.connected) return
    this.dialPreparation = null
    this.socket.disconnect()
    if (missing.kind === 'signed-out') {
      this.logDialAttempt('failed', 'signed-out')
      this.blockAuthFailure()
      return
    }
    if (missing.kind === 'unanswered') {
      this.logDialAttempt('failed', 'no-grant')
      this.opts.onDialOutcome?.({ kind: 'dial-failed' })
      return
    }
    const { refusal } = missing
    this.logDialAttempt('failed', 'account-refused')
    console.warn('[solus:ws] account refused a grant for this host', {
      clientInstanceId: this.clientInstanceId,
      serverId: this.opts.serverId ?? null,
      reason: refusal.reason,
      lasting: refusal.lasting,
    })
    if (refusal.lasting) this.blockAuthFailure()
    else this.opts.onDialOutcome?.({ kind: 'dial-failed' })
  }

  /** Close for good. Every queued and later call rejects with `reason`. */
  destroy(finalStatus: ConnectionStatus = 'disconnected', reason = new TransportDisconnectedError()): void {
    if (this.destroyed) return
    this.destroyed = true
    this.closedReason = reason
    this.cancelPresentation()
    if (this.authRefreshResetTimer) clearTimeout(this.authRefreshResetTimer)
    this.authRefreshResetTimer = null
    this.socket.disconnect()
    this.rejectAllRequests()
    this.events.clear()
    this.pendingHostEvents = []
    this.onResetCallback = null
    this.setStatus(finalStatus)
  }

  get lastDialError(): DialError | null {
    return this.dialError
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

    // Records go over this socket: its principal is their authority, so no credential is exchanged.
    const records = workspaceRecordMethods(new SolusApiClient({
      contextKey: () => JSON.stringify([this.opts.serverUrl, this.opts.serverId, this.opts.organizationId?.() ?? null]),
      send: request => this.invoke('solusApiRequest', [request]),
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

  /**
   * The one credential this dial presents: an access token from the account, a guest's
   * share secret, or a paired device's session token. None is a credential-free
   * handshake, which only a trusted requester or a host without auth admits.
   */
  private async dialCredential(): Promise<DialCredential> {
    const { grants, guest, sessionToken } = this.opts
    if (grants) {
      const refused = this.refusedGrant
      const token = await grants.acquire(refused ? { refused } : undefined).catch(() => null)
      if (!token) return { kind: 'missing', missing: missingGrantOf(grants) }
      this.refusedGrant = null
      if (grants.tokenKind === 'session-token') return { kind: 'present', credential: { kind: 'session-token', token } }
      const organizationId = this.opts.dialOrganizationId?.() ?? undefined
      return { kind: 'present', credential: organizationId ? { kind: 'access-token', token, organizationId } : { kind: 'access-token', token } }
    }
    if (guest) return { kind: 'present', credential: { kind: 'share-secret', secret: guest.shareSecret, guestId: guest.guestId, displayName: guest.displayName } }
    return { kind: 'present', credential: sessionToken ? { kind: 'session-token', token: sessionToken } : undefined }
  }

  /**
   * Keeps the host holding a live token for this socket: a socket admitted with an
   * access token sends the next one before the current one ends (`authRenew`), so the
   * host moves the socket's end to it; any other socket of a signed-in person shows
   * the host their token (`accountPresent`), so the host keeps their delegation (ADR
   * 0001 §6 item 5). One timer, a little before each presented token ends. No token, a
   * token whose end cannot be read, or a host that refuses stops it until the next
   * connection; a socket admitted with a token then ends at its expiry and is dialed
   * again as for any drop.
   */
  private async presentToken(generation: number, presented: string | null): Promise<void> {
    const grants = this.opts.grants
    const accountToken = this.opts.accountToken
    if (!grants && !accountToken) return
    let token = presented
    if (!token) {
      // A source may hand back the token in use until it is near its end: ask for another then.
      token = grants ? await grants.acquire().catch(() => null) : await accountToken!().catch(() => null)
      if (!token || generation !== this.connectedGeneration) return
      try {
        await this.invoke(grants ? 'authRenew' : 'accountPresent', [{ accessToken: token }])
      } catch (error) {
        this.logConnection('token presentation refused', { message: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    const endsAt = accessTokenEndsAt(token)
    if (endsAt === null || generation !== this.connectedGeneration) return
    this.cancelPresentation()
    this.presentationTimer = setTimeout(() => {
      this.presentationTimer = null
      void this.presentToken(generation, null)
    }, Math.max(0, endsAt - GRANT_RENEWAL_LEAD_MS - Date.now()))
  }

  private cancelPresentation(): void {
    if (this.presentationTimer) clearTimeout(this.presentationTimer)
    this.presentationTimer = null
  }

  private installSocketListeners(): void {
    for (const [event, listener] of this.serverRequests) this.socket.on(event, listener)
    const markInbound = () => { this.lastInboundAt = Date.now() }
    this.socket.io.on('packet', markInbound)
    this.socket.io.on('ping', markInbound)
    this.socket.on('connect', () => {
      if (this.dialTiming) this.dialTiming.socketOpenMs = Date.now() - this.dialTiming.startedAt
      const generation = ++this.connectedGeneration
      void this.acceptConnectedSocket(generation)
    })
    this.socket.on('disconnect', (reason) => {
      this.cancelPresentation()
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
      const code = error.data?.code ?? null
      this.dialError = { message: error.message, code, at: Date.now() }
      this.logConnection('socket connection error', { message: error.message, code })
      this.logDialAttempt('failed', code === 'UNAUTHORIZED' ? 'unauthorized' : 'socket-error')
      if (code !== 'UNAUTHORIZED') {
        // With auto-reconnection off nobody else will ever dial again: the
        // failed dial is the supervisor's cue to schedule the next one.
        if (!this.destroyed && !this.blocked) this.opts.onDialOutcome?.({ kind: 'dial-failed' })
        return
      }
      if (this.opts.grants || this.opts.guest) {
        // The host refused the token (it was linked again since, or the person lost
        // their reach) or the share secret (the link was turned off or regenerated).
        // A retry asks the account for another token.
        void this.dialPreparation?.credential.then((dial) => {
          if (dial.kind === 'present' && dial.credential?.kind === 'access-token') this.refusedGrant = dial.credential.token
        })
        this.blockAuthFailure()
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
    const credential = this.dialPreparation?.credential
    this.dialPreparation = null
    const accepted = await identity
    if (this.destroyed || generation !== this.connectedGeneration || !this.socket.connected) return
    if (!accepted) {
      this.logDialAttempt('failed', 'identity-mismatch')
      this.destroy('identity-mismatch')
      this.opts.onDialOutcome?.({ kind: 'identity-mismatch' })
      return
    }

    this.markAccepted()
    const dialed = credential ? await credential : null
    const admittedWith = dialed?.kind === 'present' && dialed.credential?.kind === 'access-token' ? dialed.credential.token : null
    void this.presentToken(generation, admittedWith)
    if (this.authRefreshAttempted) {
      if (this.authRefreshResetTimer) clearTimeout(this.authRefreshResetTimer)
      this.authRefreshResetTimer = setTimeout(() => { this.authRefreshAttempted = false }, 30_000)
    }
  }

  /** The host accepted this socket: deliver what waited for it and say so. */
  private markAccepted(): void {
    this.dialError = null
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
    this.logDialAttempt('connected', null)
    if (shouldReset) this.onResetCallback?.()
    this.opts.onDialOutcome?.({ kind: 'accepted', recovered: this.socket.recovered })
    this.flushQueuedRequests()
  }

  private async recoverAuthentication(): Promise<void> {
    let refreshResult: RefreshResult = 'unavailable'
    try { refreshResult = await this.refreshToken() } catch {}
    if (this.destroyed) return
    if (refreshResult === 'unavailable') {
      // The host did not answer the refresh (a network error, a 5xx, a tunnel still
      // coming up): that says nothing about the token. Retry on the supervisor's
      // backoff, and let the next refusal try the refresh again (T3 Code #16554).
      this.authRefreshAttempted = false
      if (!this.blocked) this.opts.onDialOutcome?.({ kind: 'dial-failed' })
      return
    }
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
    if (this.opts.grants) {
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
    if (this.unreachable) return Promise.reject(new HostUnreachableError(this.opts.serverId ?? this.opts.serverUrl))
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
      }
      this.requests.set(id, entry)
      if (this.socket.connected) this.sendRequest(id, entry)
    })
  }

  private flushQueuedRequests(): void {
    for (const [id, request] of this.requests) {
      if (request.state === 'queued') this.sendRequest(id, request)
    }
  }

  /**
   * The supervisor's word that the host is past its grace. Every queued call
   * fails now, and new calls fail at once, until the host is no longer
   * unreachable: a loader then shows the host's state instead of waiting.
   */
  setUnreachable(unreachable: boolean): void {
    this.unreachable = unreachable
    if (!unreachable) return
    const error = new HostUnreachableError(this.opts.serverId ?? this.opts.serverUrl)
    for (const [id, request] of this.requests) {
      this.requests.delete(id)
      request.reject?.(error)
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

  /** One line per dial with how it ended and when each part finished, so a slow
   *  route, token, or identity check is visible (T3 Code #22081). */
  private logDialAttempt(outcome: DialAttemptOutcome, reason: string | null): void {
    const timing = this.dialTiming
    if (!timing) return
    this.dialTiming = null
    this.logConnection('connection attempt', {
      outcome,
      reason,
      serverUrl: timing.serverUrl,
      totalMs: Date.now() - timing.startedAt,
      credentialMs: timing.credentialMs ?? null,
      identityMs: timing.identityMs ?? null,
      socketOpenMs: timing.socketOpenMs ?? null,
    })
  }

  /** Asks the connected socket to prove it is alive. Rejection is a report,
   *  not an action — the supervisor decides what a failed probe means. The
   *  stale socket is hung up first so the supervisor's next dial is fresh.
   *  A probe that is late while the socket still receives data is a busy host,
   *  not a dead socket: the socket is kept (T3 Code #14518). */
  async probe(): Promise<void> {
    if (this.destroyed || this.blocked || this.wakeProbeInFlight) return
    if (!this.socket.connected) {
      throw new Error('socket is not connected')
    }
    this.wakeProbeInFlight = true
    const startedAt = Date.now()
    try {
      await withTimeout(this.invoke(WAKE_PROBE_METHOD, []), WAKE_PROBE_TIMEOUT_MS)
    } catch (error) {
      if (this.socket.connected && this.lastInboundAt >= startedAt) {
        this.logConnection('wake probe late, socket still receiving', { waitedMs: Date.now() - startedAt })
        return
      }
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
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
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

/** Why a grant source gave no token. */
function missingGrantOf(grants: GrantSource): MissingGrant {
  const refusal = grants.refusal?.() ?? null
  if (refusal) return { kind: 'refused', refusal }
  return grants.isSignedOut() ? { kind: 'signed-out' } : { kind: 'unanswered' }
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
