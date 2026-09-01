import { describe, expect, test } from 'bun:test'
import { hexToHsv, hsvToHex, normalizeHex } from '@solus/workspace-ui/components/diagram/lib/color'

describe('diagram colour picker maths', () => {
  test('accepts the shorthand and unprefixed hex a user can type into the field', () => {
    expect(normalizeHex('abc')).toBe('#aabbcc')
    expect(normalizeHex('#FF7B01')).toBe('#ff7b01')
    expect(normalizeHex('  #fff  ')).toBe('#ffffff')
  })

  test('rejects a half-typed hex so the swatch does not move mid-keystroke', () => {
    expect(normalizeHex('ff7b')).toBeNull()
    expect(normalizeHex('#ff7b0')).toBeNull()
    expect(normalizeHex('rebeccapurple')).toBeNull()
  })

  test('round-trips a stored colour, so opening the picker never shifts the node', () => {
    for (const hex of ['#ff7b01', '#4ade80', '#60a5fa', '#94a3b8', '#000000', '#ffffff']) {
      const hsv = hexToHsv(hex)
      expect(hsv).not.toBeNull()
      expect(hsvToHex(hsv!)).toBe(hex)
    }
  })

  test('reads the picker axes off a known colour', () => {
    const hsv = hexToHsv('#ff7b01')!
    expect(Math.round(hsv.h)).toBe(29)
    expect(hsv.s).toBeCloseTo(1, 2)
    expect(hsv.v).toBeCloseTo(1, 2)
  })

  test('keeps a dragged-to-black square from losing its hue on the way out', () => {
    // The square's bottom edge is v=0; only the emitted hex collapses to black.
    expect(hsvToHex({ h: 210, s: 1, v: 0 })).toBe('#000000')
    expect(hsvToHex({ h: 210, s: 0, v: 1 })).toBe('#ffffff')
  })

  test('wraps hue past the ends of the rail rather than clamping', () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe(hsvToHex({ h: 0, s: 1, v: 1 }))
    expect(hsvToHex({ h: -60, s: 1, v: 1 })).toBe(hsvToHex({ h: 300, s: 1, v: 1 }))
  })
})
