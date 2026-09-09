/** Node-only installation rules shared by the CLI and server. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function isBrewManaged(installDir: string): boolean {
  return /\/(?:Cellar|homebrew\/Cellar|linuxbrew\/Cellar)\/solus(?:-server)?\//.test(`${installDir}/`)
}

export function isTarballInstall(installDir: string): boolean {
  return ['bin/node', 'libexec/server/standalone.js', 'libexec/cli/solus.js'].every((file) => existsSync(join(installDir, file)))
}

