import { svgImageUrl } from './app-icons.store.svelte'

/** The icon is drawn once at the largest size an operating system asks for; the desktop app makes the smaller ones. */
const ICON_PIXELS = 1024

/** What a shortcut's icon is drawn from: the app's own `icon.svg` when it has one, else its monogram on its hue. */
export interface AppShortcutIconSource {
  monogram: string
  hue: number
  svg: string | null
}

/**
 * The icon of an app shortcut as a square PNG. The app's own icon fills the
 * square, as a launcher icon does. An app with no icon, or an icon that does
 * not draw, gets its tile (`AppTile.svelte`): its first letter on its hue. A
 * launcher shows on any background, so the tile uses its light colours in
 * both light and dark mode.
 */
export async function appShortcutIconPng(source: AppShortcutIconSource): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(ICON_PIXELS, ICON_PIXELS)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This client cannot draw the icon of the shortcut.')
  if (!(source.svg && await drawSvg(context, source.svg))) drawMonogram(context, source.monogram, source.hue)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return blob.arrayBuffer()
}

/** Draws the SVG to fill the square, in its own proportions; false when it does not decode. */
async function drawSvg(context: OffscreenCanvasRenderingContext2D, svg: string): Promise<boolean> {
  const image = new Image()
  image.src = svgImageUrl(svg)
  try {
    await image.decode()
  } catch {
    return false
  }
  // The host requires a viewBox: it gives the proportions of an icon that names no width and no height.
  const box = viewBoxOf(svg)
  const width = box?.width || image.naturalWidth || ICON_PIXELS
  const height = box?.height || image.naturalHeight || ICON_PIXELS
  const scale = ICON_PIXELS / Math.max(width, height)
  context.drawImage(image, (ICON_PIXELS - width * scale) / 2, (ICON_PIXELS - height * scale) / 2, width * scale, height * scale)
  return true
}

function viewBoxOf(svg: string): { width: number; height: number } | null {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  if (!(root instanceof SVGSVGElement)) return null
  const { width, height } = root.viewBox.baseVal
  return width > 0 && height > 0 ? { width, height } : null
}

function drawMonogram(context: OffscreenCanvasRenderingContext2D, monogram: string, hue: number): void {
  // The tile leaves a margin, as the icons of other apps do.
  const inset = ICON_PIXELS * 0.1
  const side = ICON_PIXELS - inset * 2
  context.fillStyle = `oklch(0.9 0.06 ${hue})`
  context.beginPath()
  context.roundRect(inset, inset, side, side, side * 0.225)
  context.fill()
  context.fillStyle = `oklch(0.42 0.1 ${hue})`
  context.font = `600 ${Math.round(side * 0.5)}px ${getComputedStyle(document.body).fontFamily}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(monogram, ICON_PIXELS / 2, ICON_PIXELS / 2 + side * 0.03)
}
