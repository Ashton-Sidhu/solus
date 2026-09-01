// Colour maths for the diagram accent picker. The picker edits in HSV because
// that is the shape of its two controls — a saturation/brightness square and a
// hue rail — while everything the diagram stores is a plain `#rrggbb` string.
// Hue is degrees (0–360); saturation and value are 0–1.

export interface Hsv {
  h: number
  s: number
  v: number
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * `abc`, `#AABBCC` → `#aabbcc`. Returns null when the text is not a colour, so
 * a half-typed hex field can keep its draft without moving the swatch.
 */
export function normalizeHex(raw: string): string | null {
  const match = HEX_PATTERN.exec(raw.trim())
  if (!match) return null
  const body = match[1].toLowerCase()
  if (body.length === 6) return `#${body}`
  return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
}

export function hexToHsv(hex: string): Hsv | null {
  const normal = normalizeHex(hex)
  if (!normal) return null
  const r = parseInt(normal.slice(1, 3), 16) / 255
  const g = parseInt(normal.slice(3, 5), 16) / 255
  const b = parseInt(normal.slice(5, 7), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const span = max - min

  let h = 0
  if (span !== 0) {
    if (max === r) h = ((g - b) / span) % 6
    else if (max === g) h = (b - r) / span + 2
    else h = (r - g) / span + 4
    h *= 60
    if (h < 0) h += 360
  }

  return { h, s: max === 0 ? 0 : span / max, v: max }
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360
  const sat = clamp01(s)
  const val = clamp01(v)

  const c = val * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = val - c

  const sextant = Math.floor(hue / 60) % 6
  const rgb =
    sextant === 0
      ? [c, x, 0]
      : sextant === 1
        ? [x, c, 0]
        : sextant === 2
          ? [0, c, x]
          : sextant === 3
            ? [0, x, c]
            : sextant === 4
              ? [x, 0, c]
              : [c, 0, x]

  return `#${rgb.map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('')}`
}
