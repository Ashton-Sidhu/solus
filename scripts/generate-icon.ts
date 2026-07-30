/**
 * Generates the macOS app icon from a single source of truth.
 *
 * Writes resources/icon-master.svg, resources/icon.png, the full
 * resources/icon.iconset/, and packs resources/icon.icns via iconutil.
 *
 *   bun run generate:icon
 */
import sharp from 'sharp'
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const RESOURCES = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources')
const ICONSET = join(RESOURCES, 'icon.iconset')

// macOS Big Sur+ icon grid: an 824pt body centred on a 1024pt canvas. The
// surrounding padding is what makes the icon sit at the same visual weight as
// native apps in the Dock — without it the artwork reads oversized.
const SIZE = 1024
const CENTER = SIZE / 2
const BODY_HALF = 824 / 2

// The mark is favicon.svg verbatim — a solid core inside three broken arcs,
// authored on a 32pt grid. Drawing it in its own coordinates and scaling the
// whole group keeps this file and the favicon a single design, not two drifting
// copies. The scale is derived per slot from the arc's outer edge so a heavier
// small-size stroke thickens inward instead of growing the mark's footprint,
// which stays at 556pt — about two-thirds of the 824pt body.
const FAVICON_GRID = 32
const ARC_R = 11
const ARC_STROKE = 2.2
const MARK_HALF = 278 // outer half-extent of the mark on the 1024pt canvas

// Surface: the white badge behind the Codex mark in the input-bar model picker.
const SURFACE = '#ffffff'
const EDGE = '#d2cfc5' // --solus-container-border
const MARK: [string, string] = ['#D97757', '#B45A3C'] // arcs, core — --solus-accent clay

type Variant = { stroke: number; core: number; arcs: boolean; mark: [string, string] }

/**
 * The mark cannot be drawn identically across the whole iconset. A thin
 * light-on-light stroke greys out as the slot shrinks, so smaller slots need a
 * heavier stroke and a darker clay — but a heavier stroke also eats the gap
 * between the arcs and the core, so the core shrinks to keep them apart. Below
 * 32px there is no gap left to defend (the body is only 13px wide), so the arcs
 * drop entirely and the mark reduces to its core.
 */
function variantFor(size: number): Variant {
  const dark: [string, string] = ['#C05939', '#A8492C']
  if (size >= 256) return { stroke: ARC_STROKE, core: 6.6, arcs: true, mark: MARK }
  if (size >= 128) return { stroke: ARC_STROKE * 1.15, core: 6.4, arcs: true, mark: MARK }
  if (size >= 64) return { stroke: ARC_STROKE * 1.4, core: 6.1, arcs: true, mark: MARK }
  if (size >= 32) return { stroke: ARC_STROKE * 1.65, core: 5.4, arcs: true, mark: dark }
  return { stroke: 0, core: 8, arcs: false, mark: dark }
}

/**
 * Apple's continuous-corner shape is a superellipse, not a rounded rect.
 * An exponent of 5 matches the silhouette of the stock system icons.
 */
function squircle(half: number, exponent = 5): string {
  const steps = 1440
  const e = 2 / exponent
  const points: string[] = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const cos = Math.cos(t)
    const sin = Math.sin(t)
    const x = CENTER + half * Math.sign(cos) * Math.abs(cos) ** e
    const y = CENTER + half * Math.sign(sin) * Math.abs(sin) ** e
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
  }
  return `M${points[0]}L${points.slice(1).join('L')}Z`
}

// The three broken arcs of favicon.svg, in its own 32pt coordinates.
const ARCS = [
  'M16,5 A11,11 0 0 1 27,16',
  'M25.24,23.48 A11,11 0 0 1 12.48,26.56',
  'M6.76,23.48 A11,11 0 0 1 5,12.48',
]

const body = squircle(BODY_HALF)

function buildSvg({ stroke, core, arcs, mark }: Variant): string {
  const scale = MARK_HALF / (arcs ? ARC_R + stroke / 2 : ARC_R)
  const offset = CENTER - (FAVICON_GRID / 2) * scale
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <filter id="cast" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#4A3A2C" flood-opacity="0.26"/>
    </filter>
  </defs>

  <g filter="url(#cast)"><path d="${body}" fill="${SURFACE}"/></g>

  <g transform="translate(${offset.toFixed(2)},${offset.toFixed(2)}) scale(${scale.toFixed(4)})">
    <circle cx="16" cy="16" r="${core}" fill="${mark[1]}"/>
${
  arcs
    ? `    <g fill="none" stroke="${mark[0]}" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round">
${ARCS.map((d) => `      <path d="${d}"/>`).join('\n')}
    </g>`
    : ''
}
  </g>

  <!-- A near-white body dissolves into light wallpapers and Finder list views,
       so it carries a hairline edge to stay contained. -->
  <path d="${body}" fill="none" stroke="${EDGE}" stroke-width="3" opacity="0.7"/>
</svg>`
}

const write = (path: string, size: number) =>
  sharp(Buffer.from(buildSvg(variantFor(size))), { density: 300 })
    .resize(size, size, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toFile(path)

mkdirSync(ICONSET, { recursive: true })
writeFileSync(join(RESOURCES, 'icon-master.svg'), buildSvg(variantFor(SIZE)))
await write(join(RESOURCES, 'icon.png'), SIZE)

// iconutil requires every slot of the standard iconset.
const slots: [string, number][] = [
  ['icon_16x16', 16],
  ['icon_16x16@2x', 32],
  ['icon_32x32', 32],
  ['icon_32x32@2x', 64],
  ['icon_128x128', 128],
  ['icon_128x128@2x', 256],
  ['icon_256x256', 256],
  ['icon_256x256@2x', 512],
  ['icon_512x512', 512],
  ['icon_512x512@2x', 1024],
]
for (const [name, size] of slots) await write(join(ICONSET, `${name}.png`), size)

execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', join(RESOURCES, 'icon.icns')])
console.log('Wrote icon-master.svg, icon.png, icon.iconset/, icon.icns')
