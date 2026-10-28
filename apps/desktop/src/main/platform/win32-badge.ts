/**
 * The count Windows shows over the taskbar button (`setOverlayIcon`). Electron
 * cannot decode an SVG into a native image, so the badge is drawn as pixels: a
 * red disc with the count in a 3x5 pixel font, white, doubled for clarity.
 */

/** Pixel rows of each glyph, three columns wide, top to bottom. */
const GLYPHS = new Map<string, readonly string[]>(Object.entries({
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
}))

/** The overlay is 16 points; this is its 2x source. */
export const BADGE_PIXELS = 32
const SCALE = 3
const GAP = SCALE

/** The badge text: the count, or `9+` above nine. */
export function badgeLabel(count: number): string {
  return count > 9 ? '9+' : String(count)
}

/** BGRA pixels for `nativeImage.createFromBitmap`, BADGE_PIXELS square. */
export function badgeBitmap(label: string): Buffer {
  const size = BADGE_PIXELS
  const pixels = Buffer.alloc(size * size * 4)
  const center = (size - 1) / 2
  const radius = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Coverage of the disc edge, for a smooth rim.
      const coverage = Math.min(1, Math.max(0, radius - Math.hypot(x - center, y - center)))
      const offset = (y * size + x) * 4
      pixels[offset] = 0x4d // blue
      pixels[offset + 1] = 0x48 // green
      pixels[offset + 2] = 0xe5 // red
      pixels[offset + 3] = Math.round(coverage * 255)
    }
  }
  const glyphs = [...label].map((char) => GLYPHS.get(char)).filter((glyph): glyph is readonly string[] => !!glyph)
  const width = glyphs.length * 3 * SCALE + (glyphs.length - 1) * GAP
  const height = 5 * SCALE
  let left = Math.round((size - width) / 2)
  const top = Math.round((size - height) / 2)
  for (const glyph of glyphs) {
    glyph.forEach((row, rowIndex) => {
      for (let column = 0; column < 3; column++) {
        if (row[column] !== '1') continue
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            const offset = ((top + rowIndex * SCALE + dy) * size + left + column * SCALE + dx) * 4
            pixels.fill(0xff, offset, offset + 4)
          }
        }
      }
    })
    left += 3 * SCALE + GAP
  }
  return pixels
}
