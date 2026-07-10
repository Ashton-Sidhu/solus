import { RPC_INVOKE_METHODS, RPC_SEND_METHODS, RPC_TOPICS } from '../shared/rpc'
import type { RpcEventEnvelope, RpcInvokeMethod, RpcSendMethod, RpcTopic } from '../shared/rpc'

/**
 * WebSocket transport shared by the browser client and the Electron renderer.
 * It exposes a `window.solus`-shaped object backed by the server's JSON RPC
 * WebSocket protocol.
 */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'blocked'

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
}

type Listener = (...payload: unknown[]) => void

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

interface QueuedRequest {
  id: string
  method: RpcInvokeMethod | RpcSendMethod
  args: unknown[]
  queuedAt: number
  queuedAfterFirstOpen: boolean
}

const RECONNECT_BACKOFFS = [1000, 2000, 4000, 8000, 16000, 30000]
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const STABLE_CONNECTION_RESET_MS = 30_000
const RECONNECT_QUEUE_MAX_AGE_MS = 15_000
const WAKE_PROBE_TIMEOUT_MS = 5_000
const WAKE_PROBE_METHOD: RpcInvokeMethod = 'connectionsGetServerInfo'

export function shouldAcceptSequencedEvent(currentSeq: number | undefined, incomingSeq: number | undefined): boolean {
  return typeof incomingSeq !== 'number' || typeof currentSeq !== 'number' || incomingSeq > currentSeq
}

export class WsTransport {
  private socket: WebSocket | null = null
  private nextId = 1
  private pending = new Map<string, PendingRequest>()
  private subscribers = new Map<RpcTopic, Set<Listener>>()
  private lastSeqByTopic = new Map<RpcTopic, number>()
  private queuedRequests: QueuedRequest[] = []
  private sentRequestIds = new Set<string>()
  private onResetCallback: (() => void) | null = null
  private status: ConnectionStatus = 'disconnected'
  private lastNotifiedAttempt = 0
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private attemptedCloseRefresh = false
  private hasOpened = false
  private openedAt: number | null = null
  private isNetworkOffline = false
  private removeLifecycleListeners: (() => void) | null = null
  private wakeProbeInFlight = false
  private reconnectImmediatelyAfterClose = false

  constructor(private opts: WsTransportOptions) {
    this.installLifecycleListeners()
  }

  start(): void {
    if (this.status === 'blocked') {
      this.attempt = 0
      this.attemptedCloseRefresh = false
    }
    this.connect()
  }

  destroy(): void {
    this.destroyed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.removeLifecycleListeners?.()
    this.removeLifecycleListeners = null
    this.socket?.close()
    this.socket = null
    this.queuedRequests.length = 0
    for (const [, p] of this.pending) p.reject(new Error('disconnected'))
    this.pending.clear()
    this.sentRequestIds.clear()
  }

  applySeqWatermark(seqByTopic: Record<string, number>, replace = false): void {
    for (const [topic, seq] of Object.entries(seqByTopic)) {
      if (typeof seq === 'number' && (replace || !this.lastSeqByTopic.has(topic as RpcTopic))) {
        this.lastSeqByTopic.set(topic as RpcTopic, seq)
      }
    }
  }

  /** Builds a `window.solus`-compatible API surface backed by this transport. */
  buildSolusApi(): Record<string, unknown> {
    const api: Record<string, unknown> = {
      // Browser defaults. Electron overlays its native-only methods at boot.
      getPlatform: () => 'web',
      getPathForFile: () => '',
      setQuoteContext: () => {},
      onQuoteSelection: () => () => {},
    }

    for (const method of RPC_INVOKE_METHODS) {
      api[method] = (...args: unknown[]) => this.invoke(method, args)
    }
    for (const method of RPC_SEND_METHODS) {
      api[method] = (...args: unknown[]) => this.send(method, args)
    }

    // Browser file picking/upload. Electron overlays getPathForFile but keeps
    // attachFiles on RPC so desktop dialogs still run on the local server.
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

    // Expose uploadFiles for browser drag-and-drop in App.svelte.
    api['uploadFiles'] = (files: File[]): Promise<unknown> => this.uploadFiles(files)

    // Event subscriptions mirror the preload's onX shape.
    api.onEvent = (cb: Listener) => this.subscribe('normalized-event', cb)
    api.onError = (cb: Listener) => this.subscribe('enriched-error', cb)
    api.onSkillStatus = (cb: Listener) => this.subscribe('skill-status', cb)
    api.onThemeChange = (cb: Listener) => this.subscribe('theme-changed', cb)
    api.onEnterDesignMode = (cb: Listener) => this.subscribe('enter-design-mode', cb)
    api.onWindowShown = (cb: Listener) => this.subscribe('window-shown', cb)
    api.onWindowHidden = (cb: Listener) => this.subscribe('window-hidden', cb)
    api.onSessionScan = (cb: Listener) => this.subscribe('session-scan', cb)
    api.onReviewProgress = (cb: Listener) => this.subscribe('review-progress', cb)
    api.onRunStatus = (cb: Listener) => this.subscribe('run-status', cb)
    api.onRunLog = (cb: Listener) => this.subscribe('run-log', cb)
    api.onSetupStatus = (cb: Listener) => this.subscribe('setup-status', cb)
    api.onSetupLog = (cb: Listener) => this.subscribe('setup-log', cb)
    api.onAutomationsChanged = (cb: Listener) => this.subscribe('automations-changed', cb)
    api.onProviderDeviceCode = (cb: Listener) => this.subscribe('provider-device-code', cb)
    api.onMergeQueueUpdate = (cb: Listener) => this.subscribe('merge-queue-update', cb)
    api.onTasksChanged = (cb: Listener) => this.subscribe('tasks-changed', cb)
    api.onPrsChanged = (cb: Listener) => this.subscribe('prs-changed', cb)
    api.onAttentionChanged = (cb: Listener) => this.subscribe('attention-changed', cb)
    api.onSeqWatermark = (cb: Listener) => this.subscribe('seq-watermark', cb)
    api.onResetRuntime = (cb: () => void) => {
      this.onResetCallback = cb
      return () => { if (this.onResetCallback === cb) this.onResetCallback = null }
    }

    return api
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

  private async connect(): Promise<void> {
    if (this.destroyed) return
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return

    this.setStatus(this.hasOpened ? 'reconnecting' : 'connecting')

    const refreshed = await this.refreshIfNeeded()
    if (refreshed === 'unauthorized') {
      this.blockAuthFailure()
      this.opts.onAuthFailed?.()
      return
    }
    if (this.destroyed) return

    const wsUrl = httpToWs(this.opts.serverUrl) + `/ws?token=${encodeURIComponent(this.opts.sessionToken)}`
    const ws = new WebSocket(wsUrl)
    this.socket = ws

    ws.addEventListener('open', () => {
      this.setStatus('connected')
      this.hasOpened = true
      this.openedAt = Date.now()
      this.attemptedCloseRefresh = false

      const lastSeqByTopic: Partial<Record<RpcTopic, number>> = {}
      this.lastSeqByTopic.forEach((seq, topic) => { lastSeqByTopic[topic] = seq })
      ws.send(JSON.stringify({ type: 'resume', lastSeqByTopic }))

      const queued = this.queuedRequests.slice()
      this.queuedRequests.length = 0
      const now = Date.now()
      for (const q of queued) {
        if (q.queuedAfterFirstOpen && now - q.queuedAt > RECONNECT_QUEUE_MAX_AGE_MS) {
          this.rejectFrame(q, new Error('disconnected'))
          continue
        }
        this.sendFrame(ws, q)
      }
    })

    ws.addEventListener('message', (e) => {
      let msg: any
      try { msg = JSON.parse(e.data) } catch { return }

      if (msg.type === 'event') {
        const env = msg as RpcEventEnvelope
        const currentSeq = this.lastSeqByTopic.get(env.topic)
        if (!shouldAcceptSequencedEvent(currentSeq, env.seq)) return
        if (typeof env.seq === 'number') this.lastSeqByTopic.set(env.topic, env.seq)
        if (env.topic === 'seq-watermark') {
          const seqByTopic = (env.payload as unknown[])[0] as Record<string, number>
          this.applySeqWatermark(seqByTopic)
        } else if (env.topic === 'seq-reset') {
          const seqByTopic = (env.payload as unknown[])[0] as Record<string, number>
          this.applySeqWatermark(seqByTopic, true)
          this.onResetCallback?.()
        }
        const set = this.subscribers.get(env.topic)
        if (set) {
          for (const l of set) {
            try { l(...(env.payload as unknown[])) } catch (err) { console.error('listener threw', err) }
          }
        }
        return
      }

      if (msg.id) {
        const pending = this.pending.get(msg.id)
        if (!pending) return
        this.pending.delete(msg.id)
        this.sentRequestIds.delete(msg.id)
        if (msg.error) pending.reject(new Error(msg.error.message ?? 'rpc error'))
        else pending.resolve(msg.result)
      }
    })

    const onClose = () => {
      this.socket = null
      const openedAt = this.openedAt
      this.openedAt = null
      if (openedAt !== null && Date.now() - openedAt >= STABLE_CONNECTION_RESET_MS) this.attempt = 0
      for (const id of this.sentRequestIds) {
        const pending = this.pending.get(id)
        if (!pending) continue
        pending.reject(new Error('disconnected'))
        this.pending.delete(id)
      }
      this.sentRequestIds.clear()
      if (this.destroyed) return
      const reconnectImmediately = this.reconnectImmediatelyAfterClose
      this.reconnectImmediatelyAfterClose = false
      this.setStatus(this.hasOpened ? 'reconnecting' : 'connecting')
      void this.refreshAfterAuthClose().then((result) => {
        if (this.destroyed) return
        if (result === 'unauthorized') {
          this.blockAuthFailure()
          this.opts.onAuthFailed?.()
          return
        }
        if (reconnectImmediately) void this.connect()
        else this.scheduleReconnect()
      })
    }
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', () => { /* close fires next */ })
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return
    if (this.status === 'blocked') return
    if (this.isNetworkOffline) return
    if (this.reconnectTimer) return
    const delay = RECONNECT_BACKOFFS[Math.min(this.attempt, RECONNECT_BACKOFFS.length - 1)]
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status && this.lastNotifiedAttempt === this.attempt) return
    this.status = status
    this.lastNotifiedAttempt = this.attempt
    this.opts.onStatusChange?.(status, this.attempt)
  }

  private invoke(method: RpcInvokeMethod, args: unknown[]): Promise<unknown> {
    const id = String(this.nextId++)
    const frame = { id, method, args }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.sendFrame(this.socket, frame)
      } else {
        this.queueFrame(frame)
      }
    })
  }

  private send(method: RpcSendMethod, args: unknown[]): void {
    const frame = { id: String(this.nextId++), method, args }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendFrame(this.socket, frame)
    } else {
      this.queueFrame(frame)
    }
  }

  private queueFrame(frame: Omit<QueuedRequest, 'queuedAt' | 'queuedAfterFirstOpen'>): void {
    if (this.status === 'blocked') {
      this.rejectFrame(frame, new Error('disconnected'))
      return
    }
    this.queuedRequests.push({ ...frame, queuedAt: Date.now(), queuedAfterFirstOpen: this.hasOpened })
  }

  private rejectFrame(frame: Pick<QueuedRequest, 'id'>, err: Error): void {
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    this.sentRequestIds.delete(frame.id)
    pending.reject(err)
  }

  private sendFrame(ws: WebSocket, frame: Omit<QueuedRequest, 'queuedAt' | 'queuedAfterFirstOpen'>): void {
    if (this.pending.has(frame.id)) this.sentRequestIds.add(frame.id)
    ws.send(JSON.stringify({ id: frame.id, method: frame.method, args: frame.args }))
  }

  private async refreshIfNeeded(): Promise<RefreshResult> {
    if (!this.opts.sessionToken) return 'fresh'
    const issuedAt = tokenIssuedAt(this.opts.sessionToken)
    if (!issuedAt || Date.now() - issuedAt <= REFRESH_AFTER_MS) return 'fresh'
    return this.refreshToken()
  }

  private async refreshAfterAuthClose(): Promise<RefreshResult> {
    if (!this.opts.sessionToken || this.attemptedCloseRefresh) return 'fresh'
    this.attemptedCloseRefresh = true
    return this.refreshToken()
  }

  private async refreshToken(): Promise<RefreshResult> {
    const refreshed = await refreshSessionToken(this.opts.serverUrl, this.opts.sessionToken)
    if (refreshed.result === 'refreshed' && refreshed.sessionToken) {
      this.opts.sessionToken = refreshed.sessionToken
      this.opts.onSessionTokenRefreshed?.(refreshed.sessionToken)
    }
    return refreshed.result
  }

  private subscribe(topic: RpcTopic, listener: Listener): () => void {
    let set = this.subscribers.get(topic)
    if (!set) { set = new Set(); this.subscribers.set(topic, set) }
    set.add(listener)
    return () => { set!.delete(listener) }
  }

  private blockAuthFailure(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnectImmediatelyAfterClose = false
    this.setStatus('blocked')
    const queued = this.queuedRequests.slice()
    this.queuedRequests.length = 0
    for (const q of queued) this.rejectFrame(q, new Error('disconnected'))
  }

  private installLifecycleListeners(): void {
    if (typeof window === 'undefined') return

    this.isNetworkOffline = typeof navigator !== 'undefined' && navigator.onLine === false

    const onOnline = () => {
      this.isNetworkOffline = false
      if (this.status === 'connected') {
        void this.probeConnectedSocket()
        return
      }
      if (this.status === 'blocked' || this.destroyed) return
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      void this.connect()
    }
    const onOffline = () => {
      this.isNetworkOffline = true
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
    }
    const onVisibilityChange = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
      if (this.status === 'connected') void this.probeConnectedSocket()
    }

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)

    this.removeLifecycleListeners = () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }

  private async probeConnectedSocket(): Promise<void> {
    if (this.destroyed || this.status === 'blocked' || this.wakeProbeInFlight) return
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.forceReconnectNow()
      return
    }

    this.wakeProbeInFlight = true
    try {
      await withTimeout(this.invoke(WAKE_PROBE_METHOD, []), WAKE_PROBE_TIMEOUT_MS)
    } catch {
      this.forceReconnectNow()
    } finally {
      this.wakeProbeInFlight = false
    }
  }

  private forceReconnectNow(): void {
    if (this.destroyed || this.status === 'blocked') return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.reconnectImmediatelyAfterClose = true
      this.socket.close()
      return
    }
    void this.connect()
  }
}

function httpToWs(url: string): string {
  if (url.startsWith('http://')) return 'ws://' + url.slice('http://'.length)
  if (url.startsWith('https://')) return 'wss://' + url.slice('https://'.length)
  return url
}

type RefreshResult = 'refreshed' | 'fresh' | 'unauthorized' | 'unavailable'

function tokenIssuedAt(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const issuedAt = Number(parts[1])
  return Number.isFinite(issuedAt) ? issuedAt : null
}

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
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export { RPC_TOPICS }
