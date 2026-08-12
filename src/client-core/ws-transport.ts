import { io, type Socket } from 'socket.io-client'
import { RPC_INVOKE_METHODS } from '../shared/rpc'
import type { RpcInvokeMethod } from '../shared/rpc'
import { MAX_ATTACHMENT_UPLOAD_BYTES, MAX_ATTACHMENT_UPLOAD_COUNT } from '../shared/rpc'
import type { Attachment, IpcContext } from '../shared/types'
import { HostEventSubscriber } from './host-event-subscriber'
import {
  encodePcm16Wav,
  MAX_VOICE_RECORDING_MINUTES,
  MAX_VOICE_SAMPLES,
} from '../shared/voice-audio'

/** WebSocket transport shared by the browser client and Electron renderer. */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'blocked' | 'identity-mismatch'

export class TransportDisconnectedError extends Error {
  code = 'TRANSPORT_DISCONNECTED'

  constructor() {
    super('disconnected')
    this.name = 'TransportDisconnectedError'
  }
}

export interface WsTransportOptions {
  /** Server URL like `http://host:port`. */
  serverUrl: string
  /** Client-side identity of the host this transport addresses. */
  serverId?: string
  /** Session token returned from pairing or the desktop local bootstrap. */
  sessionToken: string
  /** Called whenever the connection state changes. */
  onStatusChange?: (status: ConnectionStatus, attempt: number) => void
  /** Called after /auth/refresh returns a fresh token. */
  onSessionTokenRefreshed?: (sessionToken: string) => void
  /** Called when the server rejects the stored token and refresh cannot recover. */
  onAuthFailed?: () => void
  /** Confirms that a newly opened socket is still the saved host it names. */
  verifyConnectedHost?: () => Promise<boolean>
  /** Overrides the default POST to `${serverUrl}/auth/refresh`. */
  refreshToken?: () => Promise<{ result: RefreshResult; sessionToken?: string }>
  /** Keep the local desktop's native picker/path fast path. Browser clients and
   *  remote desktop targets select File objects and upload bytes instead. */
  useHostFileDialog?: boolean
}

interface RequestEntry {
  method: RpcInvokeMethod
  args: unknown[]
  state: 'queued' | 'sent'
  resolve?: (value: unknown) => void
  reject?: (err: Error) => void
  queuedAt: number
  /** Boot work must survive arbitrarily slow first startup. */
  queuedBeforeFirstConnect: boolean
}

interface RpcResponse {
  result?: unknown
  error?: { message: string }
}

const RECONNECT_QUEUE_MAX_AGE_MS = 15_000
const WAKE_PROBE_TIMEOUT_MS = 5_000
const WAKE_PROBE_METHOD: RpcInvokeMethod = 'connectionsGetServerInfo'

export function shouldRejectQueuedRequest(
  queuedAt: number,
  queuedBeforeFirstConnect: boolean,
  now: number,
): boolean {
  return !queuedBeforeFirstConnect && now - queuedAt > RECONNECT_QUEUE_MAX_AGE_MS
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('Unable to read attachment.'))
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read attachment.'))
    reader.readAsDataURL(file)
  })
}

export class WsTransport {
  readonly events = new HostEventSubscriber()
  private readonly socket: Socket
  private readonly clientInstanceId = createClientInstanceId()
  private nextId = 1
  private requests = new Map<string, RequestEntry>()
  private onResetCallback: (() => void) | null = null
  private status: ConnectionStatus = 'disconnected'
  private lastNotifiedAttempt = 0
  private attempt = 0
  private destroyed = false
  private blocked = false
  private hasOpened = false
  private authRefreshAttempted = false
  private authRefreshResetTimer: ReturnType<typeof setTimeout> | null = null
  private removeLifecycleListeners: (() => void) | null = null
  private wakeProbeInFlight = false
  private connectedGeneration = 0
  private isAcceptedConnection = false
  private pendingHostEvents: unknown[] = []

  constructor(private opts: WsTransportOptions) {
    this.socket = io(opts.serverUrl, {
      path: '/ws',
      transports: ['websocket'],
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      autoConnect: false,
      auth: (cb) => cb({ token: this.opts.sessionToken, clientInstanceId: this.clientInstanceId }),
    })
    this.installSocketListeners()
    this.installLifecycleListeners()
  }

  start(): void {
    if (this.destroyed) return
    if (this.blocked) {
      this.blocked = false
      this.authRefreshAttempted = false
      this.attempt = 0
    }
    if (!this.socket.connected) {
      this.setStatus(this.hasOpened ? 'reconnecting' : 'connecting')
      this.socket.connect()
    }
  }

  destroy(finalStatus: ConnectionStatus = 'disconnected'): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.authRefreshResetTimer) clearTimeout(this.authRefreshResetTimer)
    this.authRefreshResetTimer = null
    this.removeLifecycleListeners?.()
    this.removeLifecycleListeners = null
    this.socket.disconnect()
    this.rejectAllRequests()
    this.events.clear()
    this.pendingHostEvents = []
    this.onResetCallback = null
    this.setStatus(finalStatus)
  }

  /** Builds a `window.solus`-compatible API surface backed by this transport. */
  buildSolusApi(): object {
    const api = {
      getPlatform: () => 'web',
      getPathForFile: () => '',
      setQuoteContext: () => {},
      onQuoteSelection: () => () => {},
      onAskSelectionInNewSession: () => () => {},
    }

    for (const method of RPC_INVOKE_METHODS) {
      Reflect.set(api, method, (...args: unknown[]) => this.invoke(method, args))
    }

    // Voice recordings are intentionally kept off the RPC socket. Serializing
    // Float32 PCM as JSON expands long recordings enough to exceed Socket.IO's
    // frame limit, then reconnect replays the same undeliverable request.
    Reflect.set(api, 'transcribeAudio', (audio: Float32Array | string, ...args: unknown[]) =>
      audio instanceof Float32Array
        ? this.transcribeAudio(audio)
        : this.invoke('transcribeAudio', [audio, ...args]))

    // A link must open on the device the user is holding — the RPC would open
    // a browser on the host instead (e.g. provider sign-in verification URLs).
    Reflect.set(api, 'openExternal', (url: string): Promise<boolean> => {
      window.open(url, '_blank', 'noopener')
      return Promise.resolve(true)
    })

    if (!this.opts.useHostFileDialog) {
      Reflect.set(api, 'attachFiles', (ctx?: IpcContext): Promise<unknown> => {
        if (!ctx) return Promise.resolve(null)
        return new Promise((resolve) => {
          const input = document.createElement('input')
          input.type = 'file'
          input.multiple = true
          input.addEventListener('change', async () => {
            const files = Array.from(input.files ?? [])
            if (files.length === 0) { resolve(null); return }
            resolve(await this.uploadFiles(files, ctx))
          }, { once: true })
          input.addEventListener('cancel', () => resolve(null), { once: true })
          input.click()
        })
      })
    }
    Reflect.set(api, 'uploadFiles', (files: File[], ctx: IpcContext): Promise<unknown> => this.uploadFiles(files, ctx))

    return api
  }

  onReset(callback: () => void): () => void {
    this.onResetCallback = callback
    return () => { if (this.onResetCallback === callback) this.onResetCallback = null }
  }

  private installSocketListeners(): void {
    this.socket.on('connect', () => {
      const generation = ++this.connectedGeneration
      void this.acceptConnectedSocket(generation)
    })
    this.socket.on('disconnect', (reason) => {
      this.connectedGeneration += 1
      this.isAcceptedConnection = false
      this.pendingHostEvents = []
      this.logConnection('socket closed', { reason, pendingRequests: this.pendingRequestSummary() })
      this.requeueSentRequests()
      if (!this.destroyed && !this.blocked) this.setStatus('reconnecting')
    })
    this.socket.io.on('reconnect_attempt', (attempt) => {
      this.attempt = attempt
      this.setStatus(this.hasOpened ? 'reconnecting' : 'connecting')
    })
    this.socket.on('connect_error', (error: Error & { data?: { code?: string } }) => {
      this.logConnection('socket connection error', { message: error.message, code: error.data?.code ?? null })
      if (error.data?.code !== 'UNAUTHORIZED') return
      if (this.authRefreshAttempted) {
        this.blockAuthFailure()
        return
      }
      this.authRefreshAttempted = true
      void this.recoverAuthentication()
    })
    this.socket.on('host-event', (event: unknown) => {
      if (this.isAcceptedConnection) this.events.receive(event)
      else this.pendingHostEvents.push(event)
    })
  }

  private async acceptConnectedSocket(generation: number): Promise<void> {
    const accepted = this.opts.verifyConnectedHost
      ? await this.opts.verifyConnectedHost().catch(() => false)
      : true
    if (this.destroyed || generation !== this.connectedGeneration || !this.socket.connected) return
    if (!accepted) {
      this.destroy('identity-mismatch')
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
    this.flushQueuedRequests()
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
    this.socket.connect()
  }

  private async uploadFiles(files: File[], ctx: IpcContext): Promise<Attachment[] | null> {
    if (files.length > MAX_ATTACHMENT_UPLOAD_COUNT) return null
    try {
      const attachments: Attachment[] = []
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) return null
        const mime = file.type || 'application/octet-stream'
        const dataUrl = await readFileDataUrl(file)
        const hostPath = await this.invoke('attachUpload', [ctx, { name: file.name, mime, dataUrl }]) as string
        const isImage = mime.startsWith('image/')
        attachments.push({
          id: crypto.randomUUID(),
          type: isImage ? 'image' : 'file',
          name: file.name,
          path: hostPath,
          hostPath,
          ...(this.opts.serverId ? { hostServerId: this.opts.serverId } : {}),
          mimeType: mime,
          ...(isImage ? { dataUrl } : {}),
          size: file.size,
        })
      }
      return attachments
    } catch {
      return null
    }
  }

  private async transcribeAudio(samples: Float32Array): Promise<{ error: string | null; transcript: string | null }> {
    if (samples.length > MAX_VOICE_SAMPLES) {
      return {
        error: `Voice recordings can be up to ${MAX_VOICE_RECORDING_MINUTES} minutes long.`,
        transcript: null,
      }
    }

    const wav = encodePcm16Wav(samples)
    let response = await this.postVoiceRecording(wav)
    if (response.status === 401 && await this.refreshToken() === 'refreshed') {
      response = await this.postVoiceRecording(wav)
    }

    let body: { error?: string | null; transcript?: string | null } = {}
    try { body = await response.json() as typeof body } catch {}
    if (!response.ok) {
      return { error: body.error || `Voice upload failed (${response.status})`, transcript: null }
    }
    return {
      error: body.error ?? null,
      transcript: body.transcript ?? null,
    }
  }

  private postVoiceRecording(wav: ArrayBuffer): Promise<Response> {
    return fetch(`${this.opts.serverUrl}/voice/transcribe`, {
      method: 'POST',
      headers: {
        ...(this.opts.sessionToken ? { authorization: `Bearer ${this.opts.sessionToken}` } : {}),
        'content-type': 'audio/wav',
      },
      body: wav,
    })
  }

  private invoke(method: RpcInvokeMethod, args: unknown[]): Promise<unknown> {
    if (this.destroyed || this.blocked) return Promise.reject(new TransportDisconnectedError())
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const entry: RequestEntry = {
        method,
        args,
        state: 'queued',
        resolve,
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
      if (response.error) current.reject?.(new Error(response.error.message ?? 'rpc error'))
      else current.resolve?.(response.result)
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
    const error = new TransportDisconnectedError()
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
    this.socket.connect()
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

  private logConnection(message: string, data: object): void {
    console.info(`[solus:ws] ${message}`, {
      clientInstanceId: this.clientInstanceId,
      status: this.status,
      ...data,
    })
  }

  private installLifecycleListeners(): void {
    if (typeof window === 'undefined') return
    const onOnline = () => {
      if (this.status === 'connected') void this.probeConnectedSocket()
      else this.reconnectNow()
    }
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && this.status === 'connected') {
        void this.probeConnectedSocket()
      }
    }

    window.addEventListener('online', onOnline)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)
    this.removeLifecycleListeners = () => {
      window.removeEventListener('online', onOnline)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }

  private async probeConnectedSocket(): Promise<void> {
    if (this.destroyed || this.blocked || this.wakeProbeInFlight) return
    if (!this.socket.connected) {
      this.reconnectNow()
      return
    }
    this.wakeProbeInFlight = true
    try {
      await withTimeout(this.invoke(WAKE_PROBE_METHOD, []), WAKE_PROBE_TIMEOUT_MS)
    } catch {
      this.reconnectNow()
    } finally {
      this.wakeProbeInFlight = false
    }
  }
}

function createClientInstanceId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
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
    const body = await res.json() as { sessionToken?: string }
    return body.sessionToken ? { result: 'refreshed', sessionToken: body.sessionToken } : { result: 'unavailable' }
  } catch {
    return { result: 'unavailable' }
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
