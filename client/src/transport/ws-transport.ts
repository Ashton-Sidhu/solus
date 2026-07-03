import { RPC_INVOKE_METHODS, RPC_SEND_METHODS, RPC_TOPICS } from '../../../src/shared/rpc'
import type { RpcInvokeMethod, RpcSendMethod, RpcTopic, RpcEventEnvelope } from '../../../src/shared/rpc'

/**
 * WebSocket transport — the web mirror of the Electron preload. After
 * connecting and authenticating with the user's session token, it exposes a
 * `window.solus`-shaped object that App.svelte can use unmodified.
 *
 * Wire format mirrors `src/main/transports/websocket.ts`:
 *
 *   client → server:  { id, method, args }
 *                     { type: "resume", lastSeqByTopic }
 *
 *   server → client:  { id, result } | { id, error }
 *                     { type: "event", topic, seq, payload }
 */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export interface WsTransportOptions {
  /** Server URL like `http://host:port`. */
  serverUrl: string
  /** Session token returned from /pair. Sent as `Authorization: Bearer …`. */
  sessionToken: string
  /** Called whenever the connection state changes. */
  onStatusChange?: (status: ConnectionStatus, attempt: number) => void
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
}

const RECONNECT_BACKOFFS = [1000, 2000, 4000, 8000, 16000, 30000]

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
  private seqWatermarkCount = 0
  private onResetCallback: (() => void) | null = null
  private status: ConnectionStatus = 'disconnected'
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  constructor(private opts: WsTransportOptions) {}

  start(): void {
    this.connect()
  }

  destroy(): void {
    this.destroyed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.socket?.close()
    this.socket = null
    this.queuedRequests.length = 0
    for (const [, p] of this.pending) p.reject(new Error('disconnected'))
    this.pending.clear()
    this.sentRequestIds.clear()
    this.seqWatermarkCount = 0
  }

  applySeqWatermark(seqByTopic: Record<string, number>): void {
    for (const [topic, seq] of Object.entries(seqByTopic)) {
      if (typeof seq === 'number') this.lastSeqByTopic.set(topic as RpcTopic, seq)
    }
  }

  /** Builds a `window.solus`-compatible API surface backed by this transport. */
  buildSolusApi(): Record<string, unknown> {
    const api: Record<string, unknown> = {
      // Native-only stubs — see the plan §4 for the gate strategy.
      getPlatform: () => 'web',
      getPathForFile: () => '',
      // Quote-in-reply rides the native context menu, so these never fire on web.
      setQuoteContext: () => {},
      onQuoteSelection: () => () => {},
    }

    for (const method of RPC_INVOKE_METHODS) {
      api[method] = (...args: unknown[]) => this.invoke(method, args)
    }
    for (const method of RPC_SEND_METHODS) {
      api[method] = (...args: unknown[]) => this.send(method, args)
    }

    // Override attachFiles — the server-side handler opens a native OS dialog
    // which would pop up on the server machine, not the user's browser.
    // Instead, show a browser file picker and upload the selected files.
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

    // Expose uploadFiles for web drag-and-drop in App.svelte.
    api['uploadFiles'] = (files: File[]): Promise<unknown> => this.uploadFiles(files)

    // Event subscriptions mirror the preload's `onX` shape.
    api.onEvent          = (cb: Listener) => this.subscribe('normalized-event', cb)
    api.onError          = (cb: Listener) => this.subscribe('enriched-error', cb)
    api.onSkillStatus    = (cb: Listener) => this.subscribe('skill-status', cb)
    api.onThemeChange    = (cb: Listener) => this.subscribe('theme-changed', cb)
    api.onEnterDesignMode = (cb: Listener) => this.subscribe('enter-design-mode', cb)
    api.onWindowShown    = (cb: Listener) => this.subscribe('window-shown', cb)
    api.onWindowHidden   = (cb: Listener) => this.subscribe('window-hidden', cb)
    api.onSessionScan    = (cb: Listener) => this.subscribe('session-scan', cb)
    api.onReviewProgress = (cb: Listener) => this.subscribe('review-progress', cb)
    api.onRunStatus      = (cb: Listener) => this.subscribe('run-status', cb)
    api.onRunLog         = (cb: Listener) => this.subscribe('run-log', cb)
    api.onTasksChanged   = (cb: Listener) => this.subscribe('tasks-changed', cb)
    api.onSeqWatermark   = (cb: Listener) => this.subscribe('seq-watermark', cb)
    api.onResetRuntime   = (cb: () => void) => {
      this.onResetCallback = cb
      return () => { if (this.onResetCallback === cb) this.onResetCallback = null }
    }

    return api
  }

  private async uploadFiles(files: File[]): Promise<unknown> {
    const formData = new FormData()
    for (const file of files) formData.append('file', file, file.name)
    try {
      const res = await fetch(`${this.opts.serverUrl}/upload`, { method: 'POST', body: formData })
      if (!res.ok) return null
      const json = await res.json() as { attachments?: unknown }
      return json.attachments ?? null
    } catch {
      return null
    }
  }

  // ─── internals ───

  private connect(): void {
    if (this.destroyed) return

    this.setStatus(this.attempt > 0 ? 'reconnecting' : 'connecting')

    const wsUrl = httpToWs(this.opts.serverUrl) + `/ws?token=${encodeURIComponent(this.opts.sessionToken)}`
    const ws = new WebSocket(wsUrl)
    this.socket = ws

    ws.addEventListener('open', () => {
      this.setStatus('connected')
      this.attempt = 0

      // Tell the server which sequence numbers we last saw, per topic. The
      // server will replay anything newer; if the buffer doesn't reach back
      // far enough, it sends a seq-watermark reset event.
      const lastSeqByTopic: Partial<Record<RpcTopic, number>> = {}
      this.lastSeqByTopic.forEach((seq, topic) => { lastSeqByTopic[topic] = seq })
      ws.send(JSON.stringify({ type: 'resume', lastSeqByTopic }))

      // Flush any RPCs queued while disconnected.
      const queued = this.queuedRequests.slice()
      this.queuedRequests.length = 0
      for (const q of queued) this.sendFrame(ws, q)
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
          const isReset = this.seqWatermarkCount > 0
          this.seqWatermarkCount++
          if (isReset) this.onResetCallback?.()
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
      // Reject requests that were already sent on this socket. Requests still
      // waiting in `queuedRequests` stay pending and will be sent on reconnect.
      for (const id of this.sentRequestIds) {
        const pending = this.pending.get(id)
        if (!pending) continue
        pending.reject(new Error('disconnected'))
        this.pending.delete(id)
      }
      this.sentRequestIds.clear()
      if (this.destroyed) return
      this.setStatus('reconnecting')
      this.scheduleReconnect()
    }
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', () => { /* close fires next */ })
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return
    if (this.reconnectTimer) return
    const delay = RECONNECT_BACKOFFS[Math.min(this.attempt, RECONNECT_BACKOFFS.length - 1)]
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
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
        // Queue while disconnected so optimistic prompts don't hard-fail.
        this.queuedRequests.push(frame)
      }
    })
  }

  private send(method: RpcSendMethod, args: unknown[]): void {
    const frame = { id: String(this.nextId++), method, args }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendFrame(this.socket, frame)
    } else {
      this.queuedRequests.push(frame)
    }
  }

  private sendFrame(ws: WebSocket, frame: QueuedRequest): void {
    if (this.pending.has(frame.id)) this.sentRequestIds.add(frame.id)
    ws.send(JSON.stringify(frame))
  }

  private subscribe(topic: RpcTopic, listener: Listener): () => void {
    let set = this.subscribers.get(topic)
    if (!set) { set = new Set(); this.subscribers.set(topic, set) }
    set.add(listener)
    return () => { set!.delete(listener) }
  }
}

function httpToWs(url: string): string {
  if (url.startsWith('http://')) return 'ws://' + url.slice('http://'.length)
  if (url.startsWith('https://')) return 'wss://' + url.slice('https://'.length)
  return url
}

// Expose RPC_TOPICS so callers can iterate (e.g., to wipe state on disconnect).
export { RPC_TOPICS }
