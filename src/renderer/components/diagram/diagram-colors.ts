// Single source of truth for diagram semantic colours. These hues are
// deliberately theme-agnostic (green reads as "healthy" in both light and dark);
// `muted` defers to the theme's tertiary text token. Previously STATUS_COLORS was
// copied verbatim in DiagramNode and DiagramDetailsDrawer, and the edge-drawer
// palette re-typed the same hex values by hand.
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

export const STATUS_COLORS: Record<string, string> = {
  healthy: DIAGRAM_GREEN,
  warn: DIAGRAM_AMBER,
  error: DIAGRAM_RED,
  info: DIAGRAM_BLUE,
  muted: 'var(--solus-text-tertiary)',
}
