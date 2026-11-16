/**
 * Moves streamed JPEG frames from the host socket into the viewer WebView.
 *
 * The bytes arrive in React Native, and the WebView takes only strings, so a
 * frame crosses as base64. One frame is in flight at a time: the WebView
 * acknowledges each paint, and a frame that arrives meanwhile replaces the one
 * waiting. A slow WebView then shows the newest picture instead of a queue of
 * old ones.
 */
export class FrameBridge {
  private inFlight: number | null = null
  private waiting: { seq: number; data: ArrayBuffer } | null = null

  private cancelDeadline: (() => void) | null = null

  constructor(private readonly deliver: (seq: number, base64: string) => void,
    private readonly deadline: (callback: () => void) => () => void = (callback) => {
      const timer = setTimeout(callback, 2_000)
      return () => clearTimeout(timer)
    },
  ) {}

  push(seq: number, data: ArrayBuffer): void {
    if (this.inFlight !== null) {
      this.waiting = { seq, data }
      return
    }
    this.send(seq, data)
  }

  /** The WebView painted (or dropped) the frame it was sent. */
  painted(seq: number): void {
    if (seq !== this.inFlight) return
    this.cancelDeadline?.()
    this.cancelDeadline = null
    this.inFlight = null
    const next = this.waiting
    this.waiting = null
    if (next) this.send(next.seq, next.data)
  }

  /** The WebView reloaded, so nothing it was sent will be acknowledged. */
  reset(): void {
    this.cancelDeadline?.()
    this.cancelDeadline = null
    this.inFlight = null
    this.waiting = null
  }

  private send(seq: number, data: ArrayBuffer): void {
    this.inFlight = seq
    this.cancelDeadline = this.deadline(() => this.painted(seq))
    this.deliver(seq, base64OfBytes(new Uint8Array(data)))
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 with padding. Hermes has no Buffer, and this runs for every frame. */
export function base64OfBytes(bytes: Uint8Array): string {
  const parts: string[] = []
  let chunk = ''
  const whole = bytes.length - (bytes.length % 3)
  for (let i = 0; i < whole; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    chunk += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!
    // Short strings concatenate fast; join the long result once.
    if (chunk.length >= 8192) {
      parts.push(chunk)
      chunk = ''
    }
  }
  const rest = bytes.length - whole
  if (rest === 1) {
    const n = bytes[whole]! << 16
    chunk += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = (bytes[whole]! << 16) | (bytes[whole + 1]! << 8)
    chunk += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + '='
  }
  parts.push(chunk)
  return parts.join('')
}
