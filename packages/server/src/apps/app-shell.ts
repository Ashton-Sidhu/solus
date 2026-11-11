import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SOLUS_THEME_SNAPSHOT, sandboxThemeCss } from '@solus/contracts/artifact-sandbox'
import type { AppPermissions, AppRoleState } from '@solus/contracts/apps'
import { bundledResourcesDir } from '../platform/paths'

/**
 * The document an app runs in (docs/plans/apps.md §4): the prebuilt shell,
 * the compiled component as an inline script, and the mount call. Everything
 * is inline, so a frame on any client needs no network.
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

/** `</script>` inside the component source would end the inline script early. */
function escapeInlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}

export interface AppDocumentInput {
  shell: string
  compiledComponent: string
  roles: AppRoleState[]
  permissions: AppPermissions
}

export function composeAppDocument(input: AppDocumentInput): string {
  const config = JSON.stringify({ roles: input.roles, permissions: input.permissions })
  return [
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<style id="solus-app-theme">${themeCss()}</style>`,
    '<div id="solus-app-root"></div>',
    `<script>${escapeInlineScript(input.shell)}</script>`,
    `<script>SolusAppShell.define(function(require,module,exports){\n${escapeInlineScript(input.compiledComponent)}\n});</script>`,
    `<script>SolusAppShell.mount(${escapeInlineScript(config)});</script>`,
  ].join('')
}
