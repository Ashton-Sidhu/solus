import { describe, expect, test } from 'bun:test'
import {
  AvccDemuxer,
  DeviceProtocolError,
  MAX_AVCC_ENVELOPE_BYTES,
  androidKeyMessage,
  avcCodecString,
  hidUsageForCode,
  iosInput,
  iosRawPoint,
  parseIosHelperPacket,
  parseSemuPacket,
  scanAccessUnit,
} from '@solus/client-core/device-protocol'

/**
 * Fixture bytes for the two vendored hub protocols (plan 016, stage 0). The
 * host demuxes these streams and forwards whole packets, so a split at any
 * byte must yield the same packets, and corrupt input must fail bounded
 * instead of buffering forever.
 */

function envelope(tag: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(5 + payload.length)
  new DataView(out.buffer).setUint32(0, payload.length + 1, false)
  out[4] = tag
  out.set(payload, 5)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const AVCC_FIXTURE = concat(
  envelope(1, [1, 0x64, 0x00, 0x33, 0xff]),
  envelope(2, [0, 0, 0, 2, 0x65, 0x88]),
  envelope(3, [0, 0, 0, 2, 0x41, 0x9a]),
  envelope(4, [0xff, 0xd8, 0xff, 0xd9]),
)

describe('AVCC demuxer', () => {
  test('every split point yields the same four envelopes', () => {
    // WHY: HTTP chunk boundaries are arbitrary. A packet split across reads
    // must not be dropped or emitted early.
    for (let split = 0; split <= AVCC_FIXTURE.length; split++) {
      const demuxer = new AvccDemuxer()
      const chunks = [
        ...demuxer.push(AVCC_FIXTURE.subarray(0, split)),
        ...demuxer.push(AVCC_FIXTURE.subarray(split)),
      ]
      expect(chunks.map((chunk) => chunk.type)).toEqual(['description', 'keyframe', 'delta', 'seed'])
      expect(Array.from(chunks[1]!.payload)).toEqual([0, 0, 0, 2, 0x65, 0x88])
    }
  })

  test('byte-at-a-time delivery still demuxes', () => {
    const demuxer = new AvccDemuxer()
    const chunks = Array.from(AVCC_FIXTURE).flatMap((byte) => demuxer.push(new Uint8Array([byte])))
    expect(chunks).toHaveLength(4)
  })

  test('an oversized envelope fails instead of buffering without limit', () => {
    // WHY: a corrupt length prefix must not make the host allocate gigabytes.
    const header = new Uint8Array(5)
    new DataView(header.buffer).setUint32(0, MAX_AVCC_ENVELOPE_BYTES + 1, false)
    expect(() => new AvccDemuxer().push(header)).toThrow(DeviceProtocolError)
  })

  test('the codec string comes from the avcC profile bytes', () => {
    expect(avcCodecString(new Uint8Array([1, 0x64, 0x00, 0x33]))).toBe('avc1.640033')
  })
})

describe('SEMU packets', () => {
  test('a keyframe header is parsed and stripped', () => {
    const packet = new Uint8Array(20)
    const view = new DataView(packet.buffer)
    view.setUint32(0, 0x53454d55, false)
    view.setUint8(4, 1)
    view.setUint8(5, 1)
    view.setBigUint64(8, 1234n, false)
    packet.set([0, 0, 1, 0x65], 16)
    const parsed = parseSemuPacket(packet)
    expect(parsed.isKey).toBe(true)
    expect(parsed.timestamp).toBe(1234)
    expect(Array.from(parsed.data)).toEqual([0, 0, 1, 0x65])
  })

  test('a bare access unit is scanned for IDR and SPS', () => {
    const unit = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e, 0, 0, 1, 0x65, 0x88])
    expect(parseSemuPacket(unit).isKey).toBeNull()
    const scanned = scanAccessUnit(unit)
    expect(scanned.isKey).toBe(true)
    expect(avcCodecString(scanned.sps!)).toBe('avc1.42e01e')
  })
})

describe('input encoding', () => {
  test('iOS touch is a tagged JSON packet', () => {
    const bytes = iosInput.touch('begin', 0.5, 0.25)
    expect(bytes[0]).toBe(0x03)
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(1)))).toEqual({ type: 'begin', x: 0.5, y: 0.25 })
  })

  test('iOS screen config is read back from the helper', () => {
    const json = new TextEncoder().encode(JSON.stringify({ width: 1179, height: 2556, orientation: 'portrait' }))
    const packet = concat(new Uint8Array([0x82]), json)
    expect(parseIosHelperPacket(packet)).toEqual({ width: 1179, height: 2556, orientation: 'portrait' })
    expect(parseIosHelperPacket(concat(new Uint8Array([0x82]), new TextEncoder().encode('{"width":-1}')))).toBeNull()
  })

  test('rotated iOS input is remapped into the raw framebuffer', () => {
    // WHY: serve-sim streams the unrotated framebuffer; an unmapped tap in
    // landscape lands on the wrong control.
    const screen = { width: 1179, height: 2556, orientation: 'landscape_left' as const }
    expect(iosRawPoint(screen, 0.2, 0.7)).toEqual({ x: 0.7, y: 0.8 })
  })

  test('keys map to HID usages and Android key messages', () => {
    expect(hidUsageForCode('KeyA')).toBe(0x04)
    expect(hidUsageForCode('Digit0')).toBe(0x27)
    expect(hidUsageForCode('F13')).toBeNull()
    expect(androidKeyMessage('Escape', false)).toBe(JSON.stringify({ type: 'back' }))
    expect(androidKeyMessage('a', false)).toBe(JSON.stringify({ type: 'text', text: 'a' }))
    expect(androidKeyMessage('a', true)).toBeNull()
  })
})
