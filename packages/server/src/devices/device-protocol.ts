/**
 * The wire formats of the two streaming servers expo-device-hub vendors.
 * Adapted from T3 Code (MIT, pingdotgg/t3code@43bd667,
 * packages/client-runtime/src/device/stream.ts).
 *
 * - iOS (serve-sim): video is an HTTP `stream.avcc` body of length-prefixed
 *   envelopes (`u32be length, u8 tag, payload`; tag 1 avcC description,
 *   2 keyframe, 3 delta, 4 JPEG seed). Input goes over `helper/ws` as
 *   `[tag][json]` packets; the helper answers with screen-config packets.
 * - Android (serve-emu): one WebSocket carries H.264 access units with a
 *   16-byte "SEMU" header and accepts JSON gestures.
 *
 * Solus speaks both on the host and forwards packets to clients unchanged
 * apart from the Solus frame header (docs/plans/native-devices.md, D2).
 */
import { z } from 'zod'
import {
  DEVICE_ORIENTATIONS,
  type DeviceButton,
  type DeviceOrientation,
  type DeviceScreenConfig,
} from '@solus/contracts/device-types'

export type AvccChunk = {
  readonly type: 'description' | 'keyframe' | 'delta' | 'seed'
  readonly payload: Uint8Array
}

function avccType(tag: number | undefined): AvccChunk['type'] | null {
  switch (tag) {
    case 1: return 'description'
    case 2: return 'keyframe'
    case 3: return 'delta'
    case 4: return 'seed'
    default: return null
  }
}

/** An envelope larger than this is not video; the stream is corrupt. */
export const MAX_AVCC_ENVELOPE_BYTES = 8 * 1024 * 1024

export class DeviceProtocolError extends Error {}

/** Turns a fragmented AVCC byte stream into complete envelopes. Bounded: one
 *  envelope over `MAX_AVCC_ENVELOPE_BYTES` throws instead of growing forever. */
export class AvccDemuxer {
  private buffer = new Uint8Array(64 * 1024)
  private length = 0

  push(bytes: Uint8Array): AvccChunk[] {
    if (this.length + bytes.length > this.buffer.length) {
      let capacity = this.buffer.length
      while (capacity < this.length + bytes.length) capacity *= 2
      if (capacity > MAX_AVCC_ENVELOPE_BYTES * 2) {
        this.reset()
        throw new DeviceProtocolError('avcc_buffer_overflow')
      }
      const grown = new Uint8Array(capacity)
      grown.set(this.buffer.subarray(0, this.length))
      this.buffer = grown
    }
    this.buffer.set(bytes, this.length)
    this.length += bytes.length

    const chunks: AvccChunk[] = []
    let offset = 0
    while (this.length - offset >= 4) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4)
      const frameLength = view.getUint32(0, false)
      if (frameLength > MAX_AVCC_ENVELOPE_BYTES) {
        this.reset()
        throw new DeviceProtocolError('avcc_envelope_too_large')
      }
      if (this.length - offset - 4 < frameLength) break
      if (frameLength >= 1) {
        const type = avccType(this.buffer[offset + 4])
        if (type) chunks.push({ type, payload: this.buffer.slice(offset + 5, offset + 4 + frameLength) })
      }
      offset += 4 + frameLength
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length)
      this.length -= offset
    }
    return chunks
  }

  reset(): void {
    this.length = 0
  }
}

const SEMU_MAGIC = 0x53454d55
const SEMU_HEADER_BYTES = 16
const SEMU_FLAG_KEY = 1

export interface SemuPacket {
  readonly data: Uint8Array
  /** Null when the packet carried no SEMU header; scan the access unit instead. */
  readonly isKey: boolean | null
  readonly timestamp: number | null
}

/** Split serve-emu's SEMU-framed message into metadata and the Annex-B payload. */
export function parseSemuPacket(bytes: Uint8Array): SemuPacket {
  if (bytes.byteLength > SEMU_HEADER_BYTES) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, SEMU_HEADER_BYTES)
    if (view.getUint32(0, false) === SEMU_MAGIC && view.getUint8(4) === 1) {
      const pts = view.getBigUint64(8, false)
      return {
        data: bytes.subarray(SEMU_HEADER_BYTES),
        isKey: (view.getUint8(5) & SEMU_FLAG_KEY) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      }
    }
  }
  return { data: bytes, isKey: null, timestamp: null }
}

export interface AccessUnitScan {
  isKey: boolean
  sps: Uint8Array | null
}

/** Walk an Annex-B access unit for its keyframe flag and SPS bytes. */
export function scanAccessUnit(buf: Uint8Array): AccessUnitScan {
  let isKey = false
  let sps: Uint8Array | null = null
  const len = buf.length
  let i = 0
  while (i + 2 < len) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      let codeLen = 0
      if (buf[i + 2] === 1) codeLen = 3
      else if (i + 3 < len && buf[i + 2] === 0 && buf[i + 3] === 1) codeLen = 4
      if (codeLen) {
        const nalType = buf[i + codeLen]! & 0x1f
        if (nalType === 7 && !sps) sps = buf.subarray(i + codeLen)
        if (nalType === 5) isKey = true
        i += codeLen + 1
        continue
      }
    }
    i++
  }
  return { isKey, sps }
}

const videoSessionSchema = z.object({ type: z.literal('video-session') })

/** serve-emu announces an encoder restart (rotation, resize) as a text message. */
export function isVideoSessionMessage(text: string): boolean {
  try {
    return videoSessionSchema.safeParse(JSON.parse(text)).success
  } catch {
    return false
  }
}

// serve-sim binary WS message tags (client -> helper).
const IOS_MSG_TOUCH = 0x03
const IOS_MSG_BUTTON = 0x04
const IOS_MSG_KEY = 0x06
const IOS_MSG_ORIENTATION = 0x07
const IOS_MSG_HARDWARE_KEYBOARD = 0x0d
// helper -> client.
const IOS_TAG_SCREEN_CONFIG = 0x82

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function taggedJson<Payload extends object>(tag: number, payload: Payload): Uint8Array {
  const json = encoder.encode(JSON.stringify(payload))
  const out = new Uint8Array(1 + json.length)
  out[0] = tag
  out.set(json, 1)
  return out
}

const screenConfigSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  orientation: z.enum(DEVICE_ORIENTATIONS),
  screenId: z.number().optional().catch(undefined),
})

/** Decode a helper -> host packet. Only screen config matters to Solus. */
export function parseIosHelperPacket(bytes: Uint8Array): DeviceScreenConfig | null {
  if (bytes.length < 2 || bytes[0] !== IOS_TAG_SCREEN_CONFIG) return null
  try {
    const parsed = screenConfigSchema.safeParse(JSON.parse(decoder.decode(bytes.subarray(1))))
    if (!parsed.success) return null
    const config: DeviceScreenConfig = { width: parsed.data.width, height: parsed.data.height, orientation: parsed.data.orientation }
    if (parsed.data.screenId !== undefined) config.screenId = parsed.data.screenId
    return config
  } catch {
    return null
  }
}

export const iosInput = {
  hardwareKeyboard: (enabled: boolean) => taggedJson(IOS_MSG_HARDWARE_KEYBOARD, { enabled }),
  touch: (phase: 'begin' | 'move' | 'end', x: number, y: number) =>
    taggedJson(IOS_MSG_TOUCH, { type: phase, x, y }),
  key: (phase: 'down' | 'up', usage: number) => taggedJson(IOS_MSG_KEY, { type: phase, usage }),
  button: (button: 'home' | 'app_switcher' | 'lock') => taggedJson(IOS_MSG_BUTTON, { button }),
  orientation: (orientation: DeviceOrientation) => taggedJson(IOS_MSG_ORIENTATION, { orientation }),
}

export const androidInput = {
  touch: (action: 'down' | 'move' | 'up', x: number, y: number) =>
    JSON.stringify({ type: 'touch', action, x, y }),
  key: (keycode: number) => JSON.stringify({ type: 'key', keycode }),
  text: (text: string) => JSON.stringify({ type: 'text', text }),
  button: (type: 'home' | 'back' | 'recents' | 'power') => JSON.stringify({ type }),
  resetVideo: () => JSON.stringify({ type: 'reset-video', ack: false }),
}

/** The next orientation for a one-step iOS rotation. */
export function nextOrientation(current: DeviceOrientation): DeviceOrientation {
  return DEVICE_ORIENTATIONS[(DEVICE_ORIENTATIONS.indexOf(current) + 1) % DEVICE_ORIENTATIONS.length] ?? 'portrait'
}

export interface NormalizedPoint {
  x: number
  y: number
}

/**
 * serve-sim streams the raw framebuffer; a rotated portrait-native device needs
 * input remapped into that raw space. Coordinates are normalized 0..1.
 */
export function iosRawPoint(screen: DeviceScreenConfig | null, x: number, y: number): NormalizedPoint {
  if (!screen || screen.width > screen.height) return { x, y }
  switch (screen.orientation) {
    case 'landscape_left':
      return { x: y, y: 1 - x }
    case 'landscape_right':
      return { x: 1 - y, y: x }
    case 'portrait_upside_down':
      return { x: 1 - x, y: 1 - y }
    default:
      return { x, y }
  }
}

const HID_USAGE_BY_CODE = new Map([
  ['Enter', 0x28], ['Escape', 0x29], ['Backspace', 0x2a], ['Tab', 0x2b], ['Space', 0x2c], ['Minus', 0x2d], ['Equal', 0x2e],
  ['BracketLeft', 0x2f], ['BracketRight', 0x30], ['Backslash', 0x31], ['Semicolon', 0x33], ['Quote', 0x34],
  ['Backquote', 0x35], ['Comma', 0x36], ['Period', 0x37], ['Slash', 0x38], ['Delete', 0x4c], ['ArrowRight', 0x4f],
  ['ArrowLeft', 0x50], ['ArrowDown', 0x51], ['ArrowUp', 0x52], ['ControlLeft', 0xe0], ['ShiftLeft', 0xe1],
  ['AltLeft', 0xe2], ['MetaLeft', 0xe3], ['ControlRight', 0xe4], ['ShiftRight', 0xe5], ['AltRight', 0xe6],
  ['MetaRight', 0xe7],
])

/** USB HID usage for a `KeyboardEvent.code`, or null when iOS has no mapping. */
export function hidUsageForCode(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65)
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49)
  if (code === 'Digit0') return 0x27
  return HID_USAGE_BY_CODE.get(code) ?? null
}

const ANDROID_KEYCODE_BY_KEY = new Map([
  ['ArrowUp', 19], ['ArrowDown', 20], ['ArrowLeft', 21], ['ArrowRight', 22], ['Tab', 61], ['Enter', 66], ['Backspace', 67],
  ['Delete', 112], ['Home', 122], ['End', 123], ['PageUp', 92], ['PageDown', 93],
])

/** One Android key-down as a serve-emu message: keycode, text, or Back for Escape. */
export function androidKeyMessage(key: string, hasModifier: boolean): string | null {
  if (key === 'Escape') return androidInput.button('back')
  const keycode = ANDROID_KEYCODE_BY_KEY.get(key)
  if (keycode !== undefined) return androidInput.key(keycode)
  if ([...key].length === 1 && !hasModifier) return androidInput.text(key)
  return null
}

/** Hardware buttons each platform's helper accepts. Others are refused. */
export function iosButtonName(button: DeviceButton): 'home' | 'app_switcher' | 'lock' | null {
  if (button === 'home') return 'home'
  if (button === 'appSwitcher') return 'app_switcher'
  if (button === 'power') return 'lock'
  return null
}

export function androidButtonName(button: DeviceButton): 'home' | 'back' | 'recents' | 'power' {
  return button === 'appSwitcher' ? 'recents' : button
}

/** Build the WebCodecs `avc1.PPCCLL` string from an avcC record or an SPS NAL. */
export function avcCodecString(bytes: Uint8Array): string {
  if (bytes.length < 4) return 'avc1.42E01E'
  const hex = (byte: number) => byte.toString(16).padStart(2, '0')
  return `avc1.${hex(bytes[1]!)}${hex(bytes[2]!)}${hex(bytes[3]!)}`
}
