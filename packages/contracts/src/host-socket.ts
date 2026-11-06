import { z } from 'zod'
import { socketHandshakeSchema } from './uplink'
import { hostEventEnvelopeSchema } from './host-events'
import type { BrowserFrameHeader } from './browser-types'

/**
 * The host socket: one plain WebSocket per host on `/ws`, between a client and a
 * host. Every text frame is one JSON object with a `t` field, or a part of one
 * (`splitTextFrame`); a binary frame is a streamed browser frame (`encodeBrowserFrame`).
 *
 * The client sends `hello` first, with the dial's one credential. The host answers
 * `welcome` or `refused` (and then closes). Before `hello` the client may send only
 * `pong`; any other frame is refused. So the socket is ready one round trip after it
 * opens, and the client can open it before its credential is ready.
 */

export const HOST_SOCKET_PATH = '/ws'
/** The protocol a `hello` names. A host refuses a hello for another protocol. */
export const HOST_SOCKET_PROTOCOL_VERSION = 1
/** The host sends `ping` this often; the client answers `pong`. */
export const HOST_SOCKET_PING_INTERVAL_MS = 15_000
/** A side that hears nothing for the interval and this much more closes the socket. */
export const HOST_SOCKET_PING_TIMEOUT_MS = 10_000
/** The longest part of a large text frame, in UTF-16 units. UTF-8 spends at most 3 bytes on
 *  one, so a part is at most 48 KiB: about 12 s at 4,000 bytes/s, inside the ping timeout. */
const TEXT_FRAME_PART_UNITS = 16 * 1024
/** Starts every part of a text frame but the last. No JSON object starts with a record separator. */
export const TEXT_FRAME_PART_MARK = '\u001e'

/** Close codes the host uses. 4000-4999 are free for applications (RFC 6455 §7.4.2). */
export const HOST_SOCKET_CLOSE = {
  /** The host refused the hello; the `refused` frame before it says why. */
  refused: 4001,
  /** The host ended an admitted socket: its grant ended, or the host revoked it. */
  ended: 4002,
  /** The other side broke the protocol, or did not send `hello` in time. */
  protocol: 4003,
  /** The other side was silent past the ping timeout. */
  silent: 4004,
} as const

/** Where a client was in the host's event stream when its socket dropped. */
export const eventResumeSchema = z.object({
  /** The host's event stream for this client; a host that restarted has another. */
  epoch: z.string().min(1).max(64),
  /** The last event sequence number the client received. */
  seq: z.number().int().min(0),
})
export type EventResume = z.infer<typeof eventResumeSchema>

export const helloFrameSchema = socketHandshakeSchema.extend({
  t: z.literal('hello'),
  v: z.number().int(),
  resume: eventResumeSchema.optional(),
  /** This client joins parts of a text frame. A host that does not know the field sends whole frames. */
  frameParts: z.literal(true).optional(),
})
export type HelloFrame = z.infer<typeof helloFrameSchema>

const rpcRequestFrameSchema = z.object({
  t: z.literal('rpc'),
  id: z.string().min(1).max(128),
  method: z.string().min(1).max(256),
  args: z.array(z.unknown()),
})

const replyFrameSchema = z.object({
  t: z.literal('reply'),
  id: z.string().min(1).max(128),
  payload: z.unknown(),
})

const pongFrameSchema = z.object({ t: z.literal('pong') })

/** Every text frame a client sends. */
export const clientFrameSchema = z.discriminatedUnion('t', [helloFrameSchema, rpcRequestFrameSchema, replyFrameSchema, pongFrameSchema])
export type ClientFrame = z.infer<typeof clientFrameSchema>

/** A refusal a client acts on: `UNAUTHORIZED` (the credential), `PROTOCOL` (the frame order or version). */
export const hostSocketRefusalCodeSchema = z.enum(['UNAUTHORIZED', 'PROTOCOL'])
export type HostSocketRefusalCode = z.infer<typeof hostSocketRefusalCodeSchema>

const welcomeFrameSchema = z.object({
  t: z.literal('welcome'),
  /** The event stream this socket continues; the client names it in its next `hello`. */
  epoch: z.string(),
  /** The last event number in that stream before this socket: where a client that did not recover starts. */
  seq: z.number().int().min(0),
  /** True when the host replays every event since the client's `resume`: no reload is needed. */
  recovered: z.boolean(),
})

const refusedFrameSchema = z.object({
  t: z.literal('refused'),
  code: z.string(),
  message: z.string(),
})

// An unreadable error message degrades to the generic one; the code is kept,
// since a surface acts on it (`SEAT_REQUIRED`).
const rpcResultFrameSchema = z.object({
  t: z.literal('result'),
  id: z.string(),
  result: z.unknown().optional(),
  error: z.object({
    message: z.string().optional().catch(undefined),
    code: z.string().optional().catch(undefined),
  }).optional().catch(undefined),
})

const eventFrameSchema = z.object({
  t: z.literal('event'),
  seq: z.number().int(),
  event: hostEventEnvelopeSchema,
})

const serverRequestFrameSchema = z.object({
  t: z.literal('request'),
  id: z.string(),
  event: z.string(),
  payload: z.unknown(),
})

const pingFrameSchema = z.object({ t: z.literal('ping') })

/** Every text frame a host sends. */
export const serverFrameSchema = z.discriminatedUnion('t', [
  welcomeFrameSchema,
  refusedFrameSchema,
  rpcResultFrameSchema,
  eventFrameSchema,
  serverRequestFrameSchema,
  pingFrameSchema,
])
export type ServerFrame = z.infer<typeof serverFrameSchema>
export type ServerFrameInput = z.input<typeof serverFrameSchema>
export type WelcomeFrame = z.infer<typeof welcomeFrameSchema>
export type RefusedFrame = z.infer<typeof refusedFrameSchema>
export type RpcResultFrame = z.infer<typeof rpcResultFrameSchema>

/** The WebSocket URL of a host's socket, from its HTTP origin. */
export function hostSocketUrl(serverUrl: string): string {
  const url = new URL(HOST_SOCKET_PATH, serverUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/**
 * A WebSocket message arrives whole, so a large frame on a slow link hides every
 * sign of life until its last byte, and each side reads that as a dead socket.
 * The parts of a frame go one after the other, with nothing between them. Each part
 * that arrives is a sign of life, and the client answers it with `pong`.
 */
export function splitTextFrame(text: string): string[] {
  if (text.length <= TEXT_FRAME_PART_UNITS) return [text]
  const parts: string[] = []
  let start = 0
  while (text.length - start > TEXT_FRAME_PART_UNITS) {
    const end = start + TEXT_FRAME_PART_UNITS
    // A surrogate pair stays in one part: half of one does not survive UTF-8.
    const lastUnit = text.charCodeAt(end - 1)
    const cut = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? end - 1 : end
    parts.push(TEXT_FRAME_PART_MARK + text.slice(start, cut))
    start = cut
  }
  parts.push(text.slice(start))
  return parts
}

/**
 * A browser frame on the wire: a 4-byte big-endian header length, the header as
 * UTF-8 JSON, then the JPEG bytes. One binary frame, so the header and its bytes
 * never arrive apart.
 */
export function encodeBrowserFrame(header: BrowserFrameHeader, data: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const frame = new Uint8Array(4 + headerBytes.length + data.byteLength)
  new DataView(frame.buffer).setUint32(0, headerBytes.length)
  frame.set(headerBytes, 4)
  frame.set(data, 4 + headerBytes.length)
  return frame
}

const browserFrameHeaderSchema = z.object({ browserPageId: z.string().min(1), seq: z.number() })
const headerDecoder = new TextDecoder()

/** The header and bytes of one browser frame; null when the frame is not one. */
export function decodeBrowserFrame(frame: ArrayBuffer): { header: BrowserFrameHeader; data: Uint8Array } | null {
  if (frame.byteLength < 4) return null
  const headerLength = new DataView(frame).getUint32(0)
  if (4 + headerLength > frame.byteLength) return null
  try {
    const header = browserFrameHeaderSchema.safeParse(JSON.parse(headerDecoder.decode(new Uint8Array(frame, 4, headerLength))))
    return header.success ? { header: header.data, data: new Uint8Array(frame, 4 + headerLength) } : null
  } catch {
    return null
  }
}
