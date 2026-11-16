import type { AppSummary } from '@solus/contracts/apps'

/**
 * The colour of an app's tile: its monogram in the sidebar, on the Overview, and
 * on mobile. The owner picks a hue from the palette (`appUpdate`); an app with no
 * pick takes a hue from its id, so it has the same colour on every client and
 * apps differ from each other. Each client draws the hue at its own lightness
 * for light and dark mode.
 */

/** The hues the owner picks from, in the order the picker shows them. */
export const APP_TILE_HUES = [
  { hue: 25, label: 'Red' },
  { hue: 55, label: 'Orange' },
  { hue: 85, label: 'Amber' },
  { hue: 145, label: 'Green' },
  { hue: 185, label: 'Teal' },
  { hue: 235, label: 'Blue' },
  { hue: 275, label: 'Indigo' },
  { hue: 310, label: 'Purple' },
  { hue: 350, label: 'Pink' },
] as const

export function appTileHue(app: Pick<AppSummary, 'id' | 'colorHue'>): number {
  if (app.colorHue !== null) return app.colorHue
  let hash = 0
  for (const char of app.id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360
  return hash
}

/** The tile's one letter: the first character of the name, upper case. */
export function appMonogram(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}
