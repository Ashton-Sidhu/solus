/**
 * The WebSocket that client-core dials. Desktop and web use the browser's own;
 * a client whose platform socket lacks something the host needs gives its own
 * factory once at startup. The iOS app does this: React Native's socket there
 * never negotiates permessage-deflate (apps/mobile/UPSTREAM.md).
 */

/** The part of the WHATWG WebSocket that client-core uses. Binary frames arrive as an ArrayBuffer, text frames as a string. */
export interface ClientWebSocket {
  readonly readyState: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: ArrayBuffer | string }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', listener: () => void): void
}

export type WebSocketFactory = (url: string) => ClientWebSocket

function browserWebSocket(url: string): ClientWebSocket {
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  return socket
}

/** Dials one socket, through the factory the client gave or the platform's WebSocket. */
export let openWebSocket: WebSocketFactory = browserWebSocket

/** Dials every later socket through `next`; null restores the platform's WebSocket. */
export function setWebSocketFactory(next: WebSocketFactory | null): void {
  openWebSocket = next ?? browserWebSocket
}
