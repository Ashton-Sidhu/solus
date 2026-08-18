import type { EditorId, TerminalAppId } from '../../../../shared/types'

/**
 * Brand marks, the stand-in for an app with no committed icon under
 * `../app-icons` — only apps installed on a contributor's machine can be
 * extracted, and a CLI editor has no application bundle to extract from at all.
 * Run `bun run generate:app-icons` to replace a mark with the real artwork.
 *
 * Full-colour `logos:` marks are preferred; the rest are monochrome
 * `simple-icons:` glyphs that inherit the current text colour and so hold up in
 * both themes.
 *
 * An app with no entry falls back to a generic glyph. kitty publishes no mark in
 * either collection, and the system terminal is a role rather than a product.
 */
export const APP_LOGOS = new Map<EditorId | TerminalAppId, string>([
  ['vscode', 'logos:visual-studio-code'],
  ['cursor', 'simple-icons:cursor'],
  ['zed', 'simple-icons:zedindustries'],
  ['sublime', 'logos:sublimetext-icon'],
  ['intellij', 'logos:intellij-idea'],
  ['pycharm', 'logos:pycharm'],
  ['webstorm', 'logos:webstorm'],
  ['goland', 'logos:goland'],
  ['datagrip', 'logos:datagrip'],
  ['dataspell', 'logos:dataspell'],
  ['phpstorm', 'logos:phpstorm'],
  ['rubymine', 'logos:rubymine'],
  ['vim', 'logos:vim'],
  // Square variant: `logos:neovim` is a 3.5:1 wordmark, which renders as an
  // illegible sliver in a 14px square slot.
  ['nvim', 'simple-icons:neovim'],
  ['helix', 'simple-icons:helix'],
  ['emacs', 'logos:emacs'],
  ['ghostty', 'simple-icons:ghostty'],
  ['iterm2', 'simple-icons:iterm2'],
  ['wezterm', 'simple-icons:wezterm'],
  ['alacritty', 'simple-icons:alacritty'],
])

/**
 * Terminals Solus can find attached to the shared session but cannot launch
 * itself, keyed by the macOS application name. Warp is the one that matters:
 * it runs no startup command, so it is absent from the catalog, yet a Warp user
 * who already has the session open should still see their own terminal.
 */
const LOGOS_BY_APP_NAME = new Map<string, string>([
  ['Warp', 'simple-icons:warp'],
  ['Hyper', 'logos:hyper'],
])

/** The mark for a resolved app: by catalog id first, then by detected name. */
export function appLogoFor(
  id: EditorId | TerminalAppId | null,
  appName?: string,
): string | undefined {
  return (id ? APP_LOGOS.get(id) : undefined) ?? (appName ? LOGOS_BY_APP_NAME.get(appName) : undefined)
}

/** Registered in the build-time Iconify subset so these render offline. */
export const APP_LOGO_NAMES: string[] = [...APP_LOGOS.values(), ...LOGOS_BY_APP_NAME.values()]
