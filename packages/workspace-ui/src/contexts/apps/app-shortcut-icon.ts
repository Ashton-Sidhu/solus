/** The icon is drawn once at the largest size an operating system asks for; the desktop app makes the smaller ones. */
const ICON_PIXELS = 1024

/**
 * The icon of an app shortcut: the app's tile (`AppTile.svelte`), its first
 * letter on its hue, as a square PNG. A launcher shows on any background, so
 * the icon uses the tile's light colours in both light and dark mode.
 */
export async function appShortcutIconPng(monogram: string, hue: number): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(ICON_PIXELS, ICON_PIXELS)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This client cannot draw the icon of the shortcut.')
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
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return blob.arrayBuffer()
}
