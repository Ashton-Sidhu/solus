// Adapted from T3 Code apps/mobile/src/native/nativeWebSocket.ios.ts (MIT, see apps/mobile/UPSTREAM.md).
import { requireOptionalNativeModule } from 'expo'
import { setWebSocketFactory, type ClientWebSocket, type WebSocketFactory } from '@solus/client-core/web-socket'

interface NativeEvents {
  readonly open: { readonly id: number }
  readonly message: { readonly id: number; readonly text?: string; readonly data?: Uint8Array }
  readonly error: { readonly id: number; readonly message: string }
  readonly close: { readonly id: number; readonly code: number; readonly reason: string; readonly wasClean: boolean }
}

/** The SolusWebSocket module (modules/solus-web-socket). Each socket is a number the module assigns. */
export interface SolusWebSocketModule {
  connect(url: string, protocols: string[]): number
  sendText(id: number, text: string): void
  sendBinary(id: number, bytes: Uint8Array): void
  close(id: number, code: number, reason: string): void
  addListener<K extends keyof NativeEvents>(event: K, listener: (event: NativeEvents[K]) => void): { remove(): void }
}

interface SocketEvents {
  open: undefined
  message: { data: ArrayBuffer | string }
  close: { code: number; reason: string }
  error: undefined
}

/** The listeners of one socket, by event. */
type SocketListeners = { [K in keyof SocketEvents]: Array<(event: SocketEvents[K]) => void> }

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

/** One socket through the native module, with the browser's states and event order. */
class NativeWebSocket implements ClientWebSocket {
  readyState = CONNECTING
  private readonly listeners: SocketListeners = { open: [], message: [], close: [], error: [] }

  constructor(private readonly native: SolusWebSocketModule, private readonly id: number) {}

  addEventListener<K extends keyof SocketEvents>(type: K, listener: (event: SocketEvents[K]) => void): void {
    this.listeners[type].push(listener)
  }

  send(data: string | Uint8Array): void {
    if (this.readyState === CONNECTING) throw new Error('InvalidStateError: WebSocket is still connecting')
    // Browsers drop writes after close instead of throwing.
    if (this.readyState !== OPEN) return
    if (data instanceof Uint8Array) this.native.sendBinary(this.id, data)
    else this.native.sendText(this.id, data)
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= CLOSING) return
    this.readyState = CLOSING
    this.native.close(this.id, code, reason)
  }

  opened(): void {
    if (this.readyState !== CONNECTING) return
    this.readyState = OPEN
    this.dispatch('open', undefined)
  }

  /** Binary frames arrive as an ArrayBuffer of their own bytes, as with `binaryType = 'arraybuffer'`. */
  received(event: NativeEvents['message']): void {
    if (this.readyState !== OPEN) return
    const data = event.text ?? event.data?.slice().buffer
    if (data !== undefined) this.dispatch('message', { data })
  }

  failed(): void {
    if (this.readyState !== CLOSED) this.dispatch('error', undefined)
  }

  /** Reports the end once, with the code and reason the host sent. Later events are ignored. */
  ended(event: NativeEvents['close']): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.dispatch('close', { code: event.code, reason: event.reason })
  }

  private dispatch<K extends keyof SocketEvents>(type: K, event: SocketEvents[K]): void {
    for (const listener of this.listeners[type]) listener(event)
  }
}

/** Dials through `native`. The module's events name their socket; each goes to the socket that owns it until it ends. */
export function nativeWebSocketFactory(native: SolusWebSocketModule): WebSocketFactory {
  const sockets = new Map<number, NativeWebSocket>()
  native.addListener('open', (event) => sockets.get(event.id)?.opened())
  native.addListener('message', (event) => sockets.get(event.id)?.received(event))
  native.addListener('error', (event) => sockets.get(event.id)?.failed())
  native.addListener('close', (event) => {
    sockets.get(event.id)?.ended(event)
    sockets.delete(event.id)
  })
  return (url) => {
    const id = native.connect(url, [])
    const socket = new NativeWebSocket(native, id)
    sockets.set(id, socket)
    return socket
  }
}

// React Native's iOS WebSocket (SocketRocket) never negotiates permessage-deflate,
// so every frame from the host came uncompressed. A dev client built before this
// module existed keeps that WebSocket.
const native = requireOptionalNativeModule<SolusWebSocketModule>('SolusWebSocket')
if (native) setWebSocketFactory(nativeWebSocketFactory(native))
