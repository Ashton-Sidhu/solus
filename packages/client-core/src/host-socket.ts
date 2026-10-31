import {
  decodeBrowserFrame,
  hostSocketUrl,
  HOST_SOCKET_CLOSE,
  HOST_SOCKET_PING_INTERVAL_MS,
  HOST_SOCKET_PING_TIMEOUT_MS,
  HOST_SOCKET_PROTOCOL_VERSION,
  serverFrameSchema,
  type ClientFrame,
  type EventResume,
  type HelloFrame,
  type RefusedFrame,
  type RpcResultFrame,
  type WelcomeFrame,
} from '@solus/contracts/host-socket'
import type { SocketHandshake } from '@solus/contracts/uplink'
import type { BrowserFrameHeader } from '@solus/contracts/browser-types'
import type { hostEventEnvelopeSchema } from '@solus/contracts/host-events'
import type { z } from 'zod'

/** A host event as the frame carries it; `isHostEvent` names its type. */
export type HostEventEnvelope = z.infer<typeof hostEventEnvelopeSchema>

/**
 * Answers one request the host sends and waits on. The payload is wire input that
 * the handler for its event parses with its own schema; the answer goes back as JSON.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export type HostRequestHandler = (payload: unknown, reply: (answer: unknown) => void) => void

/** How one host socket ended. */
export interface HostSocketClose {
  /** The WebSocket opened. False: the route did not answer, or refused the upgrade. */
  opened: boolean
  /** The host sent `welcome` on this socket. */
  welcomed: boolean
  code: number
  reason: string
}

/** What a host socket tells its owner. Each call is for this socket only. */
export interface HostSocketListener {
  welcome(welcome: WelcomeFrame): void
  /** The host refused the hello. The close that follows is still reported. */
  refused(refused: RefusedFrame): void
  closed(close: HostSocketClose): void
  result(result: RpcResultFrame): void
  event?(seq: number, event: HostEventEnvelope): void
  frame?(header: BrowserFrameHeader, data: Uint8Array): void
  /** A request the host waits on, for the handler of its event. */
  request?(event: string): HostRequestHandler | undefined
  /** Anything arrived: a frame or the host's ping. */
  inbound?(): void
}

/**
 * One WebSocket to one host (`@solus/contracts/host-socket`). It opens at once;
 * `hello` may come later, when the credential is ready, and goes as soon as the
 * socket is open. It never redials: the owner makes a new one.
 */
export class HostSocket {
  private readonly ws: WebSocket
  private pendingHello: ClientFrame | null = null
  private opened = false
  private welcomed = false
  private finished = false
  private openTimer: ReturnType<typeof setTimeout> | null = null
  private silenceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(serverUrl: string, private readonly listener: HostSocketListener, options: { openTimeoutMs?: number } = {}) {
    this.ws = new WebSocket(hostSocketUrl(serverUrl))
    this.ws.binaryType = 'arraybuffer'
    if (options.openTimeoutMs !== undefined) {
      this.openTimer = setTimeout(() => this.finish({ code: 1006, reason: 'open timeout' }), options.openTimeoutMs)
    }
    this.ws.onopen = () => {
      this.opened = true
      this.clearOpenTimer()
      this.expectPing()
      if (this.pendingHello) this.send(this.pendingHello)
      this.pendingHello = null
    }
    this.ws.onmessage = (message) => this.receive(message.data)
    this.ws.onclose = (close) => this.finish({ code: close.code, reason: close.reason })
    // An error is always followed by a close, which reports it.
    this.ws.onerror = () => {}
  }

  /** True once the host sent `welcome` and until the socket ends. */
  get isWelcomed(): boolean {
    return this.welcomed && !this.finished
  }

  /** Sends the hello now, or as soon as the socket opens. */
  hello(handshake: SocketHandshake, resume?: EventResume): void {
    if (this.finished) return
    const frame: HelloFrame = { t: 'hello', v: HOST_SOCKET_PROTOCOL_VERSION, ...handshake }
    if (resume) frame.resume = resume
    if (this.opened) this.send(frame)
    else this.pendingHello = frame
  }

  /** One RPC request; its answer comes to `listener.result`. Only after `welcome`. */
  rpc(id: string, method: string, args: unknown[]): void {
    this.send({ t: 'rpc', id, method, args })
  }

  /** Ends the socket. The owner hears no `closed` for an end it asked for. */
  close(): void {
    if (this.finished) return
    this.finished = true
    this.clearTimers()
    this.ws.onopen = this.ws.onmessage = this.ws.onclose = null
    this.ws.close(1000)
  }

  private send(frame: ClientFrame): void {
    if (this.finished || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(frame))
  }

  /** Binary frames arrive as an ArrayBuffer (`binaryType`), text frames as a string. */
  private receive(data: ArrayBuffer | string): void {
    if (this.finished) return
    this.listener.inbound?.()
    if (data instanceof ArrayBuffer) {
      const frame = decodeBrowserFrame(data)
      if (frame) this.listener.frame?.(frame.header, frame.data)
      return
    }
    let json: unknown
    try { json = JSON.parse(data) } catch { return }
    const parsed = serverFrameSchema.safeParse(json)
    if (!parsed.success) return
    const frame = parsed.data
    switch (frame.t) {
      case 'welcome':
        this.welcomed = true
        this.listener.welcome(frame)
        return
      case 'refused':
        this.listener.refused(frame)
        return
      case 'result':
        this.listener.result(frame)
        return
      case 'event':
        this.listener.event?.(frame.seq, frame.event)
        return
      case 'request':
        this.listener.request?.(frame.event)?.(frame.payload, (answer) => this.send({ t: 'reply', id: frame.id, payload: answer }))
        return
      case 'ping':
        this.send({ t: 'pong' })
        this.expectPing()
    }
  }

  /** The host pings on a fixed interval; one that misses it and the timeout is gone. */
  private expectPing(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = setTimeout(() => {
      this.ws.close(HOST_SOCKET_CLOSE.silent)
      this.finish({ code: HOST_SOCKET_CLOSE.silent, reason: 'ping timeout' })
    }, HOST_SOCKET_PING_INTERVAL_MS + HOST_SOCKET_PING_TIMEOUT_MS)
  }

  private finish(close: { code: number; reason: string }): void {
    if (this.finished) return
    const welcomed = this.welcomed
    this.finished = true
    this.clearTimers()
    this.ws.onopen = this.ws.onmessage = this.ws.onclose = null
    if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) this.ws.close()
    this.listener.closed({ opened: this.opened, welcomed, ...close })
  }

  private clearOpenTimer(): void {
    if (this.openTimer) clearTimeout(this.openTimer)
    this.openTimer = null
  }

  private clearTimers(): void {
    this.clearOpenTimer()
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = null
  }
}

/** An RPC answer as the host sends it: a result, or an error with its message and code. */
export type RpcEnvelope = Omit<RpcResultFrame, 't' | 'id'>

/** A socket the host admitted, for a one-shot caller: the CLI, the Lab, a proof script. */
export interface DialedHostSocket {
  /** One RPC; resolves with the host's answer, or rejects when the socket ends first or `timeoutMs` passes. */
  call(method: string, args?: unknown[], timeoutMs?: number): Promise<RpcEnvelope>
  /** Host events as they arrive, with their sequence numbers. */
  onEvent(listener: (event: HostEventEnvelope, seq: number) => void): () => void
  onClose(listener: (close: HostSocketClose) => void): () => void
  readonly isOpen: boolean
  readonly welcome: WelcomeFrame
  close(): void
}

export type HostSocketDial =
  | { ok: true; socket: DialedHostSocket }
  /** `code` is the host's refusal code; null when the socket did not open or closed before an answer. */
  | { ok: false; code: string | null; message: string }

/** Opens a socket, says `hello`, and resolves once the host welcomed or refused it. */
export function dialHostSocket(serverUrl: string, handshake: SocketHandshake, options: { timeoutMs?: number; resume?: EventResume } = {}): Promise<HostSocketDial> {
  const pending = new Map<string, { resolve: (envelope: RpcEnvelope) => void; reject: (error: Error) => void }>()
  const eventListeners = new Set<(event: HostEventEnvelope, seq: number) => void>()
  const closeListeners = new Set<(close: HostSocketClose) => void>()
  let nextId = 1
  let open = false
  const timeoutMs = options.timeoutMs ?? 10_000
  return new Promise((resolve) => {
    let refusal: RefusedFrame | null = null
    // The host must answer the hello in time too, not only open the socket.
    const answerTimer = setTimeout(() => {
      socket.close()
      resolve({ ok: false, code: null, message: 'timed out' })
    }, timeoutMs)
    const socket: HostSocket = new HostSocket(serverUrl, {
      welcome: (welcome) => {
        clearTimeout(answerTimer)
        open = true
        resolve({ ok: true, socket: dialed(welcome) })
      },
      refused: (refused) => { refusal = refused },
      closed: (close) => {
        clearTimeout(answerTimer)
        const wasOpen = open
        open = false
        for (const request of pending.values()) request.reject(new Error('The host socket closed'))
        pending.clear()
        if (!wasOpen) {
          resolve(refusal ? { ok: false, code: refusal.code, message: refusal.message } : { ok: false, code: null, message: close.reason || `closed (${close.code})` })
          return
        }
        for (const listener of closeListeners) listener(close)
      },
      result: ({ id, result, error }) => {
        const request = pending.get(id)
        pending.delete(id)
        request?.resolve(error ? { result, error } : { result })
      },
      event: (seq, event) => { for (const listener of eventListeners) listener(event, seq) },
    })
    socket.hello(handshake, options.resume)

    const dialed = (welcome: WelcomeFrame): DialedHostSocket => ({
      welcome,
      get isOpen() { return open },
      call: (method, args = [], timeoutMs = 15_000) => new Promise((resolveCall, rejectCall) => {
        if (!open) { rejectCall(new Error('The host socket is closed')); return }
        const id = String(nextId++)
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectCall(new Error(`The ${method} request timed out`))
        }, timeoutMs)
        pending.set(id, {
          resolve: (envelope) => { clearTimeout(timer); resolveCall(envelope) },
          reject: (error) => { clearTimeout(timer); rejectCall(error) },
        })
        socket.rpc(id, method, args)
      }),
      onEvent: (listener) => { eventListeners.add(listener); return () => eventListeners.delete(listener) },
      onClose: (listener) => { closeListeners.add(listener); return () => closeListeners.delete(listener) },
      close: () => {
        if (!open) return
        open = false
        socket.close()
        for (const request of pending.values()) request.reject(new Error('The host socket closed'))
        pending.clear()
        for (const listener of closeListeners) listener({ opened: true, welcomed: true, code: 1000, reason: 'client close' })
      },
    })
  })
}
