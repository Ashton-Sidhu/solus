// What an MCP App is told about the client that shows it (MCP Apps 2026-01-26, "Host Context" and "Theming").

export const MCP_APP_MAX_HEIGHT = 2000

export const MCP_APP_DISPLAY_MODES = ['inline', 'fullscreen', 'pip'] as const
export type McpAppDisplayMode = (typeof MCP_APP_DISPLAY_MODES)[number]

/**
 * The app area of a frame in picture-in-picture on desktop and web, in CSS
 * pixels (docs/plans/mcp-first-class.md §14.2). Mobile docks it at the full
 * width instead (`MCP_APP_DOCKED_HEIGHT`).
 */
export const MCP_APP_PIP_SIZE = { width: 384, height: 256 }
/** A conversation narrower than this gets no picture-in-picture: the frame and its margins would not fit. */
export const MCP_APP_PIP_MIN_CONVERSATION_WIDTH = 480
/** The height of the app area docked above the mobile composer, in points. */
export const MCP_APP_DOCKED_HEIGHT = 200

/** An inline frame follows the height the app reports, up to `maxHeight`. A full-screen or picture-in-picture frame is a fixed box the app must fit. */
export type McpAppContainerDimensions = { width: number; maxHeight: number } | { width: number; height: number }

export function mcpAppContainerDimensions(size: { width: number; height: number }, displayMode: McpAppDisplayMode): McpAppContainerDimensions {
  return displayMode === 'inline' ? { width: size.width, maxHeight: MCP_APP_MAX_HEIGHT } : size
}

/**
 * The modes a client can give a frame now. Desktop and web float the frame
 * over its conversation, so they offer `pip` only while the conversation is
 * wide enough (`conversationWidth`). Mobile docks a new frame from the saved
 * app, so it offers `pip` only once the app is saved (`isSaved`).
 */
export function mcpAppAvailableDisplayModes(place: { conversationWidth: number } | { isSaved: boolean }): McpAppDisplayMode[] {
  const canPip = 'conversationWidth' in place ? place.conversationWidth >= MCP_APP_PIP_MIN_CONVERSATION_WIDTH : place.isSaved
  return canPip ? ['inline', 'fullscreen', 'pip'] : ['inline', 'fullscreen']
}

/**
 * The Solus colors and fonts that every style variable comes from. Each client
 * reads them from its own theme, for the current light or dark mode; the
 * variables themselves are made here, so the clients cannot give an app
 * different names or scales.
 */
export interface McpAppPalette {
  /** The surface the app sits on. */
  background: string
  /** A raised surface on it, such as a card. */
  raised: string
  /** A stronger surface, such as a selected row. */
  strong: string
  text: string
  textSecondary: string
  textTertiary: string
  border: string
  /** The focus ring. */
  accent: string
  info: string
  danger: string
  success: string
  warning: string
  fontSans: string
  fontMono: string
}

const mix = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`

/** Every standardized variable of the specification, from one palette. */
export function mcpAppStyleVariables(palette: McpAppPalette) {
  const { background, raised, strong, text, textSecondary, textTertiary, border, accent, info, danger, success, warning } = palette
  return {
    '--color-background-primary': background,
    '--color-background-secondary': raised,
    '--color-background-tertiary': strong,
    '--color-background-inverse': text,
    '--color-background-ghost': 'transparent',
    '--color-background-info': mix(info, 12),
    '--color-background-danger': mix(danger, 12),
    '--color-background-success': mix(success, 12),
    '--color-background-warning': mix(warning, 12),
    '--color-background-disabled': mix(text, 6),
    '--color-text-primary': text,
    '--color-text-secondary': textSecondary,
    '--color-text-tertiary': textTertiary,
    '--color-text-inverse': background,
    '--color-text-info': info,
    '--color-text-danger': danger,
    '--color-text-success': success,
    '--color-text-warning': warning,
    '--color-text-disabled': mix(text, 38),
    '--color-text-ghost': textTertiary,
    '--color-border-primary': border,
    '--color-border-secondary': mix(border, 70),
    '--color-border-tertiary': mix(border, 45),
    '--color-border-inverse': background,
    '--color-border-ghost': 'transparent',
    '--color-border-info': mix(info, 40),
    '--color-border-danger': mix(danger, 40),
    '--color-border-success': mix(success, 40),
    '--color-border-warning': mix(warning, 40),
    '--color-border-disabled': mix(text, 10),
    '--color-ring-primary': accent,
    '--color-ring-secondary': textTertiary,
    '--color-ring-inverse': background,
    '--color-ring-info': info,
    '--color-ring-danger': danger,
    '--color-ring-success': success,
    '--color-ring-warning': warning,
    '--font-sans': palette.fontSans,
    '--font-mono': palette.fontMono,
    '--font-weight-normal': '400',
    '--font-weight-medium': '500',
    '--font-weight-semibold': '600',
    '--font-weight-bold': '700',
    '--font-text-xs-size': '12px',
    '--font-text-sm-size': '13px',
    '--font-text-md-size': '14px',
    '--font-text-lg-size': '16px',
    '--font-heading-xs-size': '14px',
    '--font-heading-sm-size': '16px',
    '--font-heading-md-size': '18px',
    '--font-heading-lg-size': '20px',
    '--font-heading-xl-size': '24px',
    '--font-heading-2xl-size': '28px',
    '--font-heading-3xl-size': '32px',
    '--font-text-xs-line-height': '16px',
    '--font-text-sm-line-height': '18px',
    '--font-text-md-line-height': '20px',
    '--font-text-lg-line-height': '24px',
    '--font-heading-xs-line-height': '20px',
    '--font-heading-sm-line-height': '22px',
    '--font-heading-md-line-height': '24px',
    '--font-heading-lg-line-height': '28px',
    '--font-heading-xl-line-height': '32px',
    '--font-heading-2xl-line-height': '36px',
    '--font-heading-3xl-line-height': '40px',
    '--border-radius-xs': '4px',
    '--border-radius-sm': '6px',
    '--border-radius-md': '8px',
    '--border-radius-lg': '12px',
    '--border-radius-xl': '16px',
    '--border-radius-full': '9999px',
    '--border-width-regular': '1px',
    '--shadow-hairline': `0 0 0 0.5px ${border}`,
    '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.06)',
    '--shadow-md': '0 2px 8px rgba(0, 0, 0, 0.1)',
    '--shadow-lg': '0 8px 24px rgba(0, 0, 0, 0.14)',
  }
}
export type McpAppStyleVariables = ReturnType<typeof mcpAppStyleVariables>

export interface McpAppSafeAreaInsets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface McpAppHostContext {
  theme: 'light' | 'dark'
  displayMode: McpAppDisplayMode
  availableDisplayModes: McpAppDisplayMode[]
  containerDimensions: McpAppContainerDimensions
  platform: 'web' | 'desktop' | 'mobile'
  locale: string
  timeZone: string
  deviceCapabilities: { touch: boolean; hover: boolean }
  safeAreaInsets?: McpAppSafeAreaInsets
  styles: { variables: McpAppStyleVariables }
}

/** What a client knows about the frame it shows an app in. */
export interface McpAppView {
  theme: 'light' | 'dark'
  displayMode: McpAppDisplayMode
  /** What the client can give this frame now (`mcpAppAvailableDisplayModes`). */
  availableDisplayModes: McpAppDisplayMode[]
  size: { width: number; height: number }
  platform: McpAppHostContext['platform']
  touch: boolean
  hover: boolean
  /** The part of a full-screen frame that the device covers, on a client that has one. */
  safeAreaInsets?: McpAppSafeAreaInsets
  palette: McpAppPalette
}

export function mcpAppHostContext(view: McpAppView): McpAppHostContext {
  // The runtime's own locale and zone are the person's: the browser, Electron, and Hermes take them from the device.
  const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions()
  const context: McpAppHostContext = {
    theme: view.theme,
    displayMode: view.displayMode,
    availableDisplayModes: view.availableDisplayModes,
    containerDimensions: mcpAppContainerDimensions(view.size, view.displayMode),
    platform: view.platform,
    locale,
    timeZone,
    deviceCapabilities: { touch: view.touch, hover: view.hover },
    styles: { variables: mcpAppStyleVariables(view.palette) },
  }
  if (view.safeAreaInsets) context.safeAreaInsets = view.safeAreaInsets
  return context
}
