// ─── Theme CSS ───
//
// The person's custom CSS restyles Solus on desktop and web (docs/theme-css.md).
// It is a personal setting (`themeCss`), so it follows the person to each of
// their clients. An agent writes it with `update_config` after it reads this
// guide with `read_theme`. The phone app does not apply it: React Native has no
// CSS.
//
// Theme CSS comes from agents and from pastes, so it must not load a file: a
// url() on an attribute selector can send what is on screen to another host.
// The client drops each declaration that can load one (`themeCssValueLoadsFile`).

/** About 11 KB of embedded image fits; a photo does not. */
export const THEME_CSS_MAX_LENGTH = 20_000

const LOADS_BY_NAME = /image-set\(|\bsrc\(/i
// Only CSS whitespace may come first. \s also matches U+00A0, which makes the address relative.
const URL_NOT_LOCAL = /url\((?![ \t\n\f\r]*["']?(?:data:|#))/i

/**
 * Whether one parsed declaration value can load a file. A value with var() stays
 * unparsed until use, and an escape can spell `var` or `url` in it, so every
 * value that still has a backslash is refused.
 */
export function themeCssValueLoadsFile(value: string): boolean {
  return value.includes('\\') || LOADS_BY_NAME.test(value) || URL_NOT_LOCAL.test(value)
}

/**
 * A text check for early feedback in the editor. CSS escapes can get past it; the
 * check of each parsed declaration on the client is the guard.
 */
export function themeCssLoadsFiles(css: string): boolean {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return /@import/i.test(code) || LOADS_BY_NAME.test(code) || URL_NOT_LOCAL.test(code)
}

/**
 * The color tokens theme CSS may set. The app's other colors derive from them.
 * Other custom properties change between releases. A unit test fails when one of
 * these leaves `workspace.css`.
 */
export const THEME_COLOR_TOKENS = [
  { token: '--solus-edge-bg', colors: 'window edge behind the panes' },
  { token: '--solus-container-bg', colors: 'pane surface: conversation, cards, page background' },
  { token: '--solus-container-border', colors: 'pane borders and hairlines' },
  { token: '--solus-sidebar-bg', colors: 'session sidebar and project panel' },
  { token: '--solus-surface-primary', colors: 'raised surface' },
  { token: '--solus-surface-secondary', colors: 'second raised surface' },
  { token: '--solus-surface-active', colors: 'selected row' },
  { token: '--solus-text-primary', colors: 'body text' },
  { token: '--solus-text-secondary', colors: 'secondary text' },
  { token: '--solus-text-tertiary', colors: 'quiet text and icons' },
  { token: '--solus-text-muted', colors: 'faintest text' },
  { token: '--solus-accent', colors: 'accent: links, primary buttons, focus' },
  { token: '--solus-accent-soft', colors: 'accent wash' },
  { token: '--solus-text-on-accent', colors: 'text on the accent' },
  { token: '--solus-input-bg', colors: 'input background' },
  { token: '--solus-input-border', colors: 'input border' },
  { token: '--solus-input-focus-border', colors: 'focused input border' },
  { token: '--solus-user-bubble', colors: 'user message bubble' },
  { token: '--solus-user-bubble-text', colors: 'user message text' },
  { token: '--solus-tool-bg', colors: 'tool call card' },
  { token: '--solus-tool-border', colors: 'tool call card border' },
  { token: '--solus-popover-bg', colors: 'popovers' },
  { token: '--solus-popover-border', colors: 'popover border' },
  { token: '--solus-menu-bg', colors: 'menus' },
  { token: '--solus-code-bg', colors: 'code blocks' },
  { token: '--solus-syntax-comment', colors: 'code comments' },
  { token: '--solus-syntax-keyword', colors: 'code keywords' },
  { token: '--solus-syntax-string', colors: 'code strings' },
  { token: '--solus-syntax-function', colors: 'code function names' },
  { token: '--solus-scroll-thumb', colors: 'scrollbar thumb' },
  { token: '--solus-send-bg', colors: 'send button' },
  { token: '--solus-stop-bg', colors: 'stop button and destructive actions' },
  { token: '--solus-status-running', colors: 'running status' },
  { token: '--solus-status-complete', colors: 'done status' },
  { token: '--solus-status-error', colors: 'error status' },
  { token: '--solus-diff-added-bg', colors: 'added diff lines' },
  { token: '--solus-diff-removed-bg', colors: 'removed diff lines' },
] as const

/**
 * The selectors theme CSS may rely on. Every one is a `data-slot`. Other class
 * names are Tailwind utilities and change between releases. A unit test fails
 * when one of these leaves the workspace UI source.
 */
export const THEME_CSS_HOOKS = [
  { slot: 'workspace', styles: 'the window behind every pane' },
  { slot: 'session-sidebar', styles: 'session sidebar' },
  { slot: 'session-row', styles: 'one row of the session sidebar' },
  { slot: 'project-panel', styles: 'project panel' },
  { slot: 'conversation', styles: 'conversation pane, behind the transcript' },
  { slot: 'transcript', styles: 'transcript scroller' },
  { slot: 'transcript-turn', styles: 'one turn of the transcript' },
  { slot: 'user-message', styles: 'user message bubble' },
  { slot: 'assistant-message', styles: 'agent reply text' },
  { slot: 'tool-call', styles: 'one tool call' },
  { slot: 'code-block', styles: 'code block' },
  { slot: 'composer', styles: 'the input bar where the person types' },
  { slot: 'diff-panel', styles: 'diff panel' },
  { slot: 'settings-page', styles: 'Settings' },
  { slot: 'command-palette', styles: 'command palette' },
  { slot: 'button', styles: 'button' },
  { slot: 'input-wrap', styles: 'text input' },
  { slot: 'switch', styles: 'switch' },
  { slot: 'select-trigger', styles: 'select' },
  { slot: 'tabs-trigger', styles: 'tab of a tab list' },
  { slot: 'dropdown-menu-content', styles: 'menu' },
  { slot: 'context-menu-content', styles: 'context menu' },
  { slot: 'popover-content', styles: 'popover' },
  { slot: 'tooltip-content', styles: 'tooltip' },
] as const

/** What an agent needs to restyle Solus. `read_theme` returns it. */
export const THEME_GUIDE = [
  'Theme CSS restyles Solus itself on desktop and web. The phone app does not use it.',
  'Write it with update_config: `personal.themeCss` replaces the whole CSS, and an empty string removes it. `personal.themeMode` is system, light, or dark.',
  '',
  'Colors: prefer setting color tokens to writing rules. Set them on `:root` for both appearances, or on `.light` or `.dark` for one.',
  ...THEME_COLOR_TOKENS.map((entry) => `- ${entry.token}: ${entry.colors}`),
  '',
  `Rules apply after the app's styles. themeCss holds ${THEME_CSS_MAX_LENGTH} characters.`,
  'It cannot load files: no @import, no image-set(), and url() only with data: or #id. Embed an image as a data: address and keep it near 10 KB.',
  "The app's own rules can be more specific, and some surfaces set their color inline. If a rule has no effect, add !important.",
  'Native scrollbars take ::-webkit-scrollbar and ::-webkit-scrollbar-thumb.',
  '',
  'Stable selectors (other class names change between releases; do not use them):',
  ...THEME_CSS_HOOKS.map((hook) => `- [data-slot="${hook.slot}"]: ${hook.styles}`),
  '',
  'You cannot see the result. Make small changes, then ask the person how it looks.',
  'To undo, set themeCss to an empty string. The person can also clear it in Settings > Appearance.',
].join('\n')
