/**
 * Connections from a client to a device's hub stream, through the host's hub
 * proxy. Injected into the hub stream so tests replay fixture bytes instead
 * of a simulator.
 */

export interface UpstreamSocket {
  send(data: string | Uint8Array): void
  close(): void
}

export interface UpstreamSocketHandlers {
  onOpen(): void
  onMessage(data: Uint8Array | string): void
  onClose(code: number, reason: string): void
}

export interface DeviceUpstream {
  /** Read a long-lived HTTP body. Resolves when it ends or `signal` aborts. */
  readBody(url: string, signal: AbortSignal, onChunk: (chunk: Uint8Array) => void): Promise<void>
  openSocket(url: string, handlers: UpstreamSocketHandlers): UpstreamSocket
}

export const webUpstream: DeviceUpstream = {
  async readBody(url, signal, onChunk) {
    const response = await fetch(url, { signal })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`stream ${response.status}`)
    }
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        onChunk(value)
      }
    } finally {
      reader.releaseLock()
    }
  },
  openSocket(url, handlers) {
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('open', () => handlers.onOpen())
    socket.addEventListener('message', (event) => {
      // binaryType is arraybuffer: binary arrives as an ArrayBuffer, text as a string.
      if (event.data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(event.data))
      else handlers.onMessage(String(event.data))
    })
    socket.addEventListener('close', (event) => handlers.onClose(event.code, event.reason))
    socket.addEventListener('error', () => socket.close())
    return {
      send: (data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(data)
      },
      close: () => socket.close(),
    }
  },
}

const MAX_JPEG_BYTES = 8 * 1024 * 1024

/**
 * Split a `multipart/x-mixed-replace` MJPEG body into whole JPEG images. Uses
 * each part's Content-Length when present, else the JPEG end marker. Bounded:
 * a part larger than 8 MB resets the parser.
 */
export class MjpegSplitter {
  private buffer = new Uint8Array(0)

  push(chunk: Uint8Array): Uint8Array[] {
    const next = new Uint8Array(this.buffer.length + chunk.length)
    next.set(this.buffer)
    next.set(chunk, this.buffer.length)
    this.buffer = next
    const images: Uint8Array[] = []
    for (;;) {
      const start = indexOfPair(this.buffer, 0xff, 0xd8, 0)
      if (start < 0) {
        // Keep the part headers that may precede the next image.
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - 256))
        break
      }
      const length = contentLengthBefore(this.buffer, start)
      let end = -1
      if (length !== null && start + length <= this.buffer.length) end = start + length
      else if (length === null) {
        const eoi = indexOfPair(this.buffer, 0xff, 0xd9, start + 2)
        if (eoi >= 0) end = eoi + 2
      }
      if (end < 0) {
        if (this.buffer.length - start > MAX_JPEG_BYTES) this.buffer = new Uint8Array(0)
        else if (start > 0) this.buffer = this.buffer.slice(start - Math.min(start, 256))
        break
      }
      images.push(this.buffer.slice(start, end))
      this.buffer = this.buffer.slice(end)
    }
    return images
  }
}

function indexOfPair(bytes: Uint8Array, a: number, b: number, from: number): number {
  for (let i = from; i + 1 < bytes.length; i++) if (bytes[i] === a && bytes[i + 1] === b) return i
  return -1
}

/** The Content-Length of the multipart headers just before `start`, if any. */
function contentLengthBefore(bytes: Uint8Array, start: number): number | null {
  const window = new TextDecoder().decode(bytes.subarray(Math.max(0, start - 256), start))
  const headersEnd = window.lastIndexOf('\r\n\r\n')
  if (headersEnd < 0 || headersEnd + 4 !== window.length) return null
  const match = /content-length:\s*(\d+)/i.exec(window.slice(window.lastIndexOf('--', headersEnd)))
  if (!match) return null
  const length = Number(match[1])
  return length > 0 && length <= MAX_JPEG_BYTES ? length : null
}
