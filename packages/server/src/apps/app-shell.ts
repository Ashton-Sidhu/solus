import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SOLUS_THEME_SNAPSHOT, sandboxThemeCss } from '@solus/contracts/artifact-sandbox'
import type { AppHostAccessState, AppPermissions, AppRoleState } from '@solus/contracts/apps'
import { bundledResourcesDir } from '../platform/paths'

/**
 * The document an app runs in (docs/plans/apps.md §4): the prebuilt shell,
 * the app's client module as an inline script, and the mount call. Everything
 * is inline, so a frame on any client needs no network to start.
 */

const SHELL_FILE = join('app-shell', 'shell.js')

let shellScript: Promise<string> | null = null

/** The built shell, read once per process. A missing build is a named error, not a blank frame. */
export function loadAppShell(): Promise<string> {
  shellScript ??= readFile(join(bundledResourcesDir(), SHELL_FILE), 'utf8').catch(() => {
    shellScript = null
    throw new Error('The app shell is not built on this host. Run `bun run build:app-shell`, or update Solus.')
  })
  return shellScript
}

/** Both palettes, so the shell switches with `data-theme` and never reloads. */
function themeCss(): string {
  const light = sandboxThemeCss(false, (variable) => SOLUS_THEME_SNAPSHOT.light[variable])
  const dark = sandboxThemeCss(true, (variable) => SOLUS_THEME_SNAPSHOT.dark[variable]).replace(/^:root\{/, ':root[data-theme=dark]{')
  return `${light}${dark}html{overflow:visible}`
}

/** `</script>` inside the client module would end the inline script early. */
function escapeInlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}

/** `</style>` inside a bundle's CSS would end the style element early. */
function escapeInlineStyle(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1')
}

export interface AppDocumentInput {
  shell: string
  /** The CommonJS module body the shell runs: a compiled component, or a bundle's client. */
  clientModule: string
  /** The styles a bundle's client imported. */
  css?: string
  roles: AppRoleState[]
  permissions: AppPermissions
  hostAccess: AppHostAccessState
}

export function composeAppDocument(input: AppDocumentInput): string {
  const config = JSON.stringify({ roles: input.roles, permissions: input.permissions, hostAccess: input.hostAccess })
  return [
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<style id="solus-app-theme">${themeCss()}</style>`,
    input.css ? `<style id="solus-app-styles">${escapeInlineStyle(input.css)}</style>` : '',
    '<div id="solus-app-root"></div>',
    `<script>${escapeInlineScript(input.shell)}</script>`,
    `<script>SolusAppShell.define(function(require,module,exports){\n${escapeInlineScript(input.clientModule)}\n});</script>`,
    `<script>SolusAppShell.mount(${escapeInlineScript(config)});</script>`,
  ].join('')
}
