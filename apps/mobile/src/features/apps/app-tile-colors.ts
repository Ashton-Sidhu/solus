/**
 * The colours of an app's tile on the phone. The desktop and the web draw the
 * tile in OKLCH (`@solus/client-core/app-tile` gives the hue); React Native
 * cannot read OKLCH, so this file converts the same values to sRGB hex. The
 * tile then has the same colour on every client.
 */

export type TileAppearance = 'light' | 'dark'

export interface AppTileColors {
  readonly background: string
  readonly text: string
}

/** The lightness and chroma of the desktop tile, for each appearance. */
const TILE_TONES = {
  light: { background: { l: 0.9, c: 0.06 }, text: { l: 0.42, c: 0.1 } },
  dark: { background: { l: 0.38, c: 0.07 }, text: { l: 0.9, c: 0.05 } },
} as const

function srgbChannel(linear: number): number {
  const value = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055
  // A colour outside sRGB is clipped, as a browser draws it.
  return Math.round(Math.min(Math.max(value, 0), 1) * 255)
}

/** One OKLCH colour as `#rrggbb`. `l` is 0 to 1; `h` is in degrees. */
export function oklchToHex(l: number, c: number, h: number): string {
  const radians = (h * Math.PI) / 180
  const a = c * Math.cos(radians)
  const b = c * Math.sin(radians)
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ]
  const [long, medium, short] = lms
  const rgb = [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ]
  return `#${rgb.map((channel) => srgbChannel(channel).toString(16).padStart(2, '0')).join('')}`
}

/** The background and the monogram colour of a tile on one hue. */
export function appTileColors(hue: number, appearance: TileAppearance): AppTileColors {
  const tone = TILE_TONES[appearance]
  return {
    background: oklchToHex(tone.background.l, tone.background.c, hue),
    text: oklchToHex(tone.text.l, tone.text.c, hue),
  }
}
