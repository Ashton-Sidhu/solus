import type { ThemeMode } from '@solus/contracts/host-config'

/**
 * The colours a theme tile paints its miniature of the app with. Fixed
 * values, not tokens: the Light tile has to look light while the app is dark,
 * and the other way round, so it cannot read the live theme. Sourced from the
 * light and `.dark` blocks in `index.css`; keep them in step when those move.
 */
export interface ThemePreviewColors {
  canvas: string
  sidebar: string
  surface: string
  accent: string
  /** The one ink that draws every text line, hairline, and placeholder. */
  line: string
}

export const LIGHT_PREVIEW: ThemePreviewColors = {
  canvas: '#fefefc',
  sidebar: '#f9f8f4',
  surface: '#ffffff',
  accent: '#d97757',
  line: 'rgb(42 38 24 / 0.18)',
}

export const DARK_PREVIEW: ThemePreviewColors = {
  canvas: '#262522',
  sidebar: '#211f1c',
  surface: '#302f2b',
  accent: '#e68e6b',
  line: 'rgb(240 237 229 / 0.16)',
}

export const THEME_MODE_TILES: ReadonlyArray<{
  mode: ThemeMode
  label: string
  ariaLabel: string
}> = [
  { mode: 'system', label: 'System', ariaLabel: 'Follow the system appearance' },
  { mode: 'light', label: 'Light', ariaLabel: 'Use light mode' },
  { mode: 'dark', label: 'Dark', ariaLabel: 'Use dark mode' },
]
