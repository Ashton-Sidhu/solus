import { io, type Socket } from 'socket.io-client'
import { RPC_INVOKE_METHODS, RPC_TOPICS } from '../shared/rpc'
import type { RpcInvokeMethod, RpcTopic } from '../shared/rpc'

/** WebSocket transport shared by the browser client and Electron renderer. */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'blocked'

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
  /** Session token returned from pairing or the desktop local bootstrap. */
  sessionToken: string
  /** Called whenever the connection state changes. */
  onStatusChange?: (status: ConnectionStatus, attempt: number) => void
  /** Called after /auth/refresh returns a fresh token. */
  onSessionTokenRefreshed?: (sessionToken: string) => void
  /** Called when the server rejects the stored token and refresh cannot recover. */
  onAuthFailed?: () => void
  /** Overrides the default POST to `${serverUrl}/auth/refresh`. */
  refreshToken?: () => Promise<{ result: RefreshResult; sessionToken?: string }>
}

type Listener = (...payload: unknown[]) => void

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

export class WsTransport {
  private readonly socket: Socket
  private readonly clientInstanceId = createClientInstanceId()
  private nextId = 1
  private requests = new Map<string, RequestEntry>()
  private subscribers = new Map<RpcTopic, Set<Listener>>()
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

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.authRefreshResetTimer) clearTimeout(this.authRefreshResetTimer)
    this.authRefreshResetTimer = null
    this.removeLifecycleListeners?.()
    this.removeLifecycleListeners = null
    this.socket.disconnect()
    this.rejectAllRequests()
    this.setStatus('disconnected')
  }

  /** Builds a `window.solus`-compatible API surface backed by this transport. */
  buildSolusApi(): Record<string, unknown> {
    const api: Record<string, unknown> = {
      getPlatform: () => 'web',
      getPathForFile: () => '',
      setQuoteContext: () => {},
      onQuoteSelection: () => () => {},
    }

    for (const method of RPC_INVOKE_METHODS) {
      api[method] = (...args: unknown[]) => this.invoke(method, args)
    }

    // Float32Array does not survive JSON serialization as an array.
    api.transcribeAudio = (audio: Float32Array | string, ...args: unknown[]) =>
      this.invoke('transcribeAudio', [audio instanceof Float32Array ? Array.from(audio) : audio, ...args])

    api['attachFiles'] = (): Promise<unknown> => {
      return new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        input.addEventListener('change', async () => {
          const files = Array.from(input.files ?? [])
          if (files.length === 0) { resolve(null); return }
          resolve(await this.uploadFiles(files))
        }, { once: true })
        input.addEventListener('cancel', () => resolve(null), { once: true })
        input.click()
      })
    }
    api['uploadFiles'] = (files: File[]): Promise<unknown> => this.uploadFiles(files)

    api.onEvent = (cb: Listener) => this.subscribe('normalized-event', cb)
    api.onError = (cb: Listener) => this.subscribe('enriched-error', cb)
    api.onSkillStatus = (cb: Listener) => this.subscribe('skill-status', cb)
    api.onThemeChange = (cb: Listener) => this.subscribe('theme-changed', cb)
    api.onEnterDesignMode = (cb: Listener) => this.subscribe('enter-design-mode', cb)
    api.onWindowShown = (cb: Listener) => this.subscribe('window-shown', cb)
    api.onWindowHidden = (cb: Listener) => this.subscribe('window-hidden', cb)
    api.onSessionScan = (cb: Listener) => this.subscribe('session-scan', cb)
    api.onSessionIndexUpdated = (cb: Listener) => this.subscribe('session-index-updated', cb)
    api.onReviewProgress = (cb: Listener) => this.subscribe('review-progress', cb)
    api.onRunStatus = (cb: Listener) => this.subscribe('run-status', cb)
    api.onRunLog = (cb: Listener) => this.subscribe('run-log', cb)
    api.onVoiceModelStatus = (cb: Listener) => this.subscribe('voice-model-status', cb)
    api.onSetupStatus = (cb: Listener) => this.subscribe('setup-status', cb)
    api.onSetupLog = (cb: Listener) => this.subscribe('setup-log', cb)
    api.onAutomationsChanged = (cb: Listener) => this.subscribe('automations-changed', cb)
    api.onProviderDeviceCode = (cb: Listener) => this.subscribe('provider-device-code', cb)
    api.onTasksChanged = (cb: Listener) => this.subscribe('tasks-changed', cb)
    api.onPrsChanged = (cb: Listener) => this.subscribe('prs-changed', cb)
    api.onAttentionChanged = (cb: Listener) => this.subscribe('attention-changed', cb)
    api.onStackGraphUpdate = (cb: Listener) => this.subscribe('stack-graph-update', cb)
    api.onPrChecksUpdate = (cb: Listener) => this.subscribe('pr-checks-update', cb)
    api.onPrGuideStatus = (cb: Listener) => this.subscribe('pr-guide-status', cb)
    api.onResetRuntime = (cb: () => void) => {
      this.onResetCallback = cb
      return () => { if (this.onResetCallback === cb) this.onResetCallback = null }
    }

    return api
  }

  private installSocketListeners(): void {
    this.socket.on('connect', () => {
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
    })
    this.socket.on('disconnect', (reason) => {
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
    this.socket.on('ev', (topic: RpcTopic, payload: unknown[]) => {
      const listeners = this.subscribers.get(topic)
      if (!listeners) return
      for (const listener of listeners) {
        try { listener(...payload) } catch (err) { console.error('listener threw', err) }
      }
    })
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

  private async uploadFiles(files: File[]): Promise<unknown> {
    const formData = new FormData()
    for (const file of files) formData.append('file', file, file.name)
    try {
      const res = await fetch(`${this.opts.serverUrl}/upload`, {
        method: 'POST',
        headers: this.opts.sessionToken ? { authorization: `Bearer ${this.opts.sessionToken}` } : undefined,
        body: formData,
      })
      if (!res.ok) return null
      const json = await res.json() as { attachments?: unknown }
      return json.attachments ?? null
    } catch {
      return null
    }
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

  private subscribe(topic: RpcTopic, listener: Listener): () => void {
    let listeners = this.subscribers.get(topic)
    if (!listeners) { listeners = new Set(); this.subscribers.set(topic, listeners) }
    listeners.add(listener)
    return () => { listeners!.delete(listener) }
  }

  private blockAuthFailure(): void {
    if (this.blocked) return
    this.blocked = true
    this.socket.disconnect()
    this.setStatus('blocked')
    this.rejectAllRequests()
    this.opts.onAuthFailed?.()
  }

  private forceReconnect(): void {
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

  private logConnection(message: string, data: Record<string, unknown>): void {
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
      else this.forceReconnect()
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
      this.forceReconnect()
      return
    }
    this.wakeProbeInFlight = true
    try {
      await withTimeout(this.invoke(WAKE_PROBE_METHOD, []), WAKE_PROBE_TIMEOUT_MS)
    } catch {
      this.forceReconnect()
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

export { RPC_TOPICS }
