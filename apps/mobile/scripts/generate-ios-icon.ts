/**
 * Writes the iOS app icon, `assets/icon-ios.png`, from the canonical Solus mark
 * (`favicon.svg`, the same mark `scripts/generate-icon.ts` draws for macOS).
 * Run after the mark changes, then rebuild the native app (an icon is not
 * JavaScript, so Fast Refresh never changes it):
 *
 *   bun apps/mobile/scripts/generate-ios-icon.ts
 *
 * iOS masks the icon to its own rounded shape, so the artwork is one opaque,
 * full-bleed square: no tile, edge, shadow or transparent margin of its own.
 * The macOS icon carries all four, which on a phone read as a second tile
 * inside the system one.
 */
import sharp from 'sharp'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(MOBILE, '..', '..')

const SIZE = 1024
// The macOS body's white (`generate-icon.ts` SURFACE): one background for both.
const BACKGROUND = '#ffffff'
// The mark keeps the macOS proportion to its body: 500pt across a 742pt body.
const MARK_SPAN = SIZE * (500 / 742)
// favicon.svg's grid, and the outer edge of its arcs (radius 11 plus half the 2.2 stroke).
const FAVICON_GRID = 32
const MARK_OUTER = 11 + 2.2 / 2

/** The favicon's own drawing, without its 32pt `<svg>` wrapper. */
function faviconMark(): string {
  const favicon = readFileSync(join(ROOT, 'favicon.svg'), 'utf8')
  const body = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(favicon)?.[1]
  if (!body) throw new Error('favicon.svg has no drawing')
  return body.trim()
}

export function iosIconSvg(): string {
  const scale = MARK_SPAN / 2 / MARK_OUTER
  const offset = SIZE / 2 - (FAVICON_GRID / 2) * scale
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${BACKGROUND}"/>
  <g transform="translate(${offset.toFixed(2)},${offset.toFixed(2)}) scale(${scale.toFixed(4)})">
    ${faviconMark()}
  </g>
</svg>`
}

if (import.meta.main) {
  const svg = iosIconSvg()
  writeFileSync(join(MOBILE, 'assets', 'icon-ios.svg'), `${svg}\n`)
  // App Store icons must be opaque: flatten onto the background and drop alpha.
  await sharp(Buffer.from(svg), { density: 300 })
    .resize(SIZE, SIZE, { kernel: 'lanczos3' })
    .flatten({ background: BACKGROUND })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(join(MOBILE, 'assets', 'icon-ios.png'))
  console.log('Wrote assets/icon-ios.svg and assets/icon-ios.png')
}
