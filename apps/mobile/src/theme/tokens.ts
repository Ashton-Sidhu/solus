/**
 * Solus colors and type for native controls, taken from the workspace tokens
 * in `packages/workspace-ui/src/workspace.css` (`--solus-*`, light `:root` and
 * `.dark`). Native code cannot read that CSS, so a changed token there must be
 * changed here too. Translucent web values are flattened onto their surface.
 */

export interface Palette {
  /** The page behind everything: the app background (`--solus-container-bg`). */
  canvas: string
  /** Content containers (`--solus-container-bg`). */
  surface: string
  /** Raised cards and the composer (`--card`). */
  card: string
  border: string
  text: string
  textSecondary: string
  textTertiary: string
  accent: string
  accentSoft: string
  onAccent: string
  danger: string
  dangerSoft: string
  /** A user's own sent message bubble: 2% ink over the page (`UserMessageBubble.svelte`). */
  userBubble: string
}

export const lightPalette: Palette = {
  canvas: '#fffffd',
  surface: '#fffffd',
  card: '#fffffd',
  border: '#d2cfc5',
  text: '#2a2618',
  textSecondary: '#484538',
  textTertiary: '#7d7a6e',
  accent: '#d97757',
  accentSoft: '#f9e8e1',
  onAccent: '#ffffff',
  danger: '#ef4444',
  dangerSoft: '#fdecec',
  userBubble: '#fbfbf8',
}

export const darkPalette: Palette = {
  canvas: '#262522',
  surface: '#262522',
  card: '#302f2b',
  border: '#45443f',
  text: '#f0ede5',
  textSecondary: '#bdbab3',
  textTertiary: '#9a978f',
  accent: '#e68e6b',
  accentSoft: '#3d2c24',
  onAccent: '#ffffff',
  danger: '#ef4444',
  dangerSoft: '#3a1f1f',
  userBubble: '#2a2926',
}

/** One density (docs/plans/single-density.md): 14px chrome; the system's text
 *  size setting scales it, never the screen size. */
export const type = {
  chrome: 14,
  dense: 12,
  body: 15,
  title: 17,
  heading: 22,
  code: 13,
} as const

/** The Solus default code font (host config `codeFontFamily: 'jetbrains-mono'`),
 *  bundled and loaded before the first screen. The interface font is the
 *  system's, which is also the Solus default (`fontFamily: 'system'`). */
export const CODE_FONT = 'JetBrainsMono_400Regular'

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const
export const radius = { sm: 6, md: 10, lg: 14 } as const
/** Apple's minimum comfortable touch target. */
export const TOUCH_TARGET = 44
