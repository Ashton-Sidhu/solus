/**
 * The Solus palette in T3 Code's palette roles (`@t3tools/shared/themePalettes`,
 * see UPSTREAM.md). The app wears T3 Code's interface with Solus's colors: T3's
 * token derivation (`mobile-theme.ts`) runs on these roles instead of T3's.
 *
 * Values come from the workspace tokens in
 * `packages/workspace-ui/src/workspace.css` (`--solus-*`, light `:root` and
 * `.dark`). Translucent web values are flattened onto the canvas, because
 * native colors here are opaque. A changed token there is changed here too.
 *
 * Backgrounds are the app's own, in both appearances: the screen is the opaque
 * `--solus-container-bg` every web and desktop surface paints edge to edge
 * (the web boot style in `apps/client/index.html`), and the drawer is the side
 * panel's `--solus-sidebar-bg-left`. Grouped cards stand apart with the shared
 * tonal `--muted` fill, not a different page colour.
 *
 * Mobile variants, on purpose (each marked `mobile:` below), for text only:
 * hairlines are a step stronger, the filled primary action is a deeper shade
 * of the accent so its white label reads at 4.5:1, and muted dark text clears
 * 4.5:1 on cards.
 */

export const THEME_COLOR_ROLES = [
  'canvas', 'chrome', 'toolbar', 'toolbarForeground', 'toolbarBorder', 'toolbarControl',
  'toolbarControlForeground', 'toolbarControlHover', 'surface', 'surfaceRaised', 'surfaceOverlay',
  'text', 'textMuted', 'border', 'input', 'focus', 'accent', 'accentForeground', 'secondary',
  'secondaryForeground', 'muted', 'mutedForeground', 'placeholder', 'secondaryLabel', 'iconMuted',
  'error', 'errorForeground', 'errorSurface', 'warning', 'warningForeground', 'warningSurface',
  'update', 'updateForeground', 'updateSurface', 'accentSurface', 'accentSurfaceForeground',
  'messageSurface', 'messageForeground', 'messageAction', 'messageActionForeground',
  'messageActionHover', 'codeBackground', 'codeForeground', 'sidebar', 'sidebarForeground',
  'sidebarMutedForeground', 'sidebarControlSurface', 'sidebarRowHover', 'sidebarRowActive',
  'sidebarRowSelected', 'sidebarBorder', 'terminalBackground', 'terminalForeground',
  'terminalCursor', 'terminalSelection', 'terminalScrollbar', 'terminalScrollbarHover',
  'composerSurface',
] as const

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number]
export type ThemeColors = Readonly<Record<ThemeColorRole, string>>
export type ThemeAppearance = 'light' | 'dark'

export const SOLUS_LIGHT_THEME_COLORS = {
  canvas: '#fffffd', // --solus-container-bg: the app background
  chrome: '#fffffd',
  toolbar: '#fffffd',
  toolbarForeground: '#2a2618', // --solus-text-primary
  toolbarBorder: '#d6d2c8', // mobile: --solus-input-border (#dadada) a step stronger for hairlines
  toolbarControl: '#fffffd', // --solus-container-bg
  toolbarControlForeground: '#2a2618',
  toolbarControlHover: '#f2f2ef', // --solus-surface-hover (6% ink) over the canvas; also --muted
  surface: '#fffffd',
  surfaceRaised: '#fffffd',
  surfaceOverlay: '#ffffff', // --solus-popover-bg
  text: '#2a2618',
  textMuted: '#7d7a6e', // --solus-text-tertiary
  border: '#d6d2c8',
  input: '#d2cfc5', // --solus-container-border
  focus: '#d97757', // --solus-accent
  accent: '#d97757',
  accentForeground: '#ffffff', // --solus-text-on-accent
  secondary: '#f4f2ec', // --solus-code-bg
  secondaryForeground: '#2a2618',
  muted: '#f4f2ec',
  mutedForeground: '#7d7a6e',
  placeholder: '#7d7a6e',
  secondaryLabel: '#7d7a6e',
  iconMuted: '#7d7a6e',
  error: '#c47060', // --solus-status-error
  errorForeground: '#a8503f',
  errorSurface: '#f8ece8',
  warning: '#d99a3d',
  warningForeground: '#965f10',
  warningSurface: '#faf2e2',
  update: '#d97757',
  updateForeground: '#a45237', // mobile: 4.6:1 on the update surface (was #b85d3f, 3.8:1)
  updateSurface: '#f9e8e1', // --solus-accent-soft over the canvas
  accentSurface: '#f9e8e1',
  accentSurfaceForeground: '#2a2618',
  // The sent user bubble as desktop paints it (`UserMessageBubble.svelte`):
  // 2% --foreground over the page. `--solus-user-bubble` is declared but unused.
  messageSurface: '#fbfbf8',
  messageForeground: '#2a2618',
  // mobile: filled primary actions take the accent's hue (16.7°) and saturation
  // at the lightest step where a white label reads 4.5:1 (4.54:1; #d97757 gives
  // 3.1:1). The accent itself stays for focus and marks.
  messageAction: '#b85c39',
  messageActionForeground: '#ffffff',
  messageActionHover: '#ab5534', // one lightness step below, same hue
  codeBackground: '#f4f2ec',
  codeForeground: '#2a2618',
  sidebar: '#fffdf8', // --solus-sidebar-bg-left: the side panel
  sidebarForeground: '#2a2618',
  sidebarMutedForeground: '#7d7a6e',
  sidebarControlSurface: '#f2f0eb', // --solus-surface-hover over the side panel
  sidebarRowHover: '#f2f0eb',
  sidebarRowActive: '#fffffd',
  sidebarRowSelected: '#fffffd',
  sidebarBorder: '#d6d2c8',
  terminalBackground: '#fffffd',
  terminalForeground: '#2a2618',
  terminalCursor: '#2a2618',
  terminalSelection: '#f0dccf',
  terminalScrollbar: '#d6d2c8',
  terminalScrollbarHover: '#c9c5b9',
  composerSurface: '#ffffff', // --solus-input-pill-bg
} as const satisfies ThemeColors

export const SOLUS_DARK_THEME_COLORS = {
  canvas: '#262522', // --solus-container-bg, opaque: the app background
  chrome: '#262522',
  toolbar: '#262522',
  toolbarForeground: '#f0ede5', // --solus-text-primary
  toolbarBorder: '#3d3c38', // --solus-container-border over the canvas
  toolbarControl: '#302f2b', // --card
  toolbarControlForeground: '#f0ede5',
  toolbarControlHover: '#2e2d2a',
  surface: '#302f2b',
  surfaceRaised: '#302f2b',
  surfaceOverlay: '#3a3935', // --solus-popover-bg
  text: '#f0ede5',
  textMuted: '#9a978f', // mobile: --solus-text-tertiary (#8a8a8a) lifted to 4.6:1 on cards
  border: '#3d3c38',
  input: '#45443f',
  focus: '#e68e6b', // --solus-accent
  accent: '#e68e6b',
  accentForeground: '#2c1a12', // --solus-text-on-accent
  secondary: '#302f2b',
  secondaryForeground: '#f0ede5',
  muted: '#2c2b28',
  mutedForeground: '#9a978f',
  placeholder: '#9a978f',
  secondaryLabel: '#9a978f',
  iconMuted: '#9a978f',
  error: '#e3645e', // --solus-status-error
  errorForeground: '#f08a84',
  errorSurface: '#3a1f1f',
  warning: '#e0a03a',
  warningForeground: '#f0c070',
  warningSurface: '#3a2d18',
  update: '#e68e6b',
  updateForeground: '#f0a585',
  updateSurface: '#3d2c24',
  accentSurface: '#3d2c24',
  accentSurfaceForeground: '#f0ede5',
  messageSurface: '#2a2926', // 2% --foreground over the page, as in light
  messageForeground: '#f0ede5',
  messageAction: '#e68e6b',
  messageActionForeground: '#2c1a12',
  messageActionHover: '#ef9c7b',
  codeBackground: '#393834', // --solus-code-bg
  codeForeground: '#f0ede5',
  sidebar: '#262522', // --solus-sidebar-bg-left: the side panel
  sidebarForeground: '#f0ede5',
  sidebarMutedForeground: '#bdbab3',
  sidebarControlSurface: '#2e2d2a',
  sidebarRowHover: '#2c2b28',
  sidebarRowActive: '#302f2b',
  sidebarRowSelected: '#302f2b',
  sidebarBorder: '#3d3c38',
  terminalBackground: '#262522',
  terminalForeground: '#f0ede5',
  terminalCursor: '#f0ede5',
  terminalSelection: '#4a3a30',
  terminalScrollbar: '#3d3c38',
  terminalScrollbarHover: '#4a4945',
  composerSurface: '#222120', // --solus-input-pill-bg over the canvas
} as const satisfies ThemeColors

export function themeColorsFor(appearance: ThemeAppearance): ThemeColors {
  return appearance === 'dark' ? SOLUS_DARK_THEME_COLORS : SOLUS_LIGHT_THEME_COLORS
}
