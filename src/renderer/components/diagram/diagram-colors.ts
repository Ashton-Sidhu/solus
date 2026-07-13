// Single source of truth for diagram colours used by node and edge palettes.
export const DIAGRAM_GREEN = '#4ade80'
export const DIAGRAM_AMBER = '#fbbf24'
export const DIAGRAM_RED = '#f87171'
export const DIAGRAM_BLUE = '#60a5fa'
export const DIAGRAM_PURPLE = '#a78bfa'
export const DIAGRAM_GRAY = '#94a3b8'

// The brand accent as raw strings, mirroring --solus-accent in index.css, for
// the places a CSS variable can't reach: SVG marker colours, canvas exports and
// the native colour-input seed. Keep in sync with the token definitions.
const ACCENT_LIGHT = '#d97757'
const ACCENT_DARK = '#e08a6e'

export function diagramAccent(isDark: boolean): string {
  return isDark ? ACCENT_DARK : ACCENT_LIGHT
}
