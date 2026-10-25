// Gives the development Electron app the Solus icon on macOS. It does nothing
// on other platforms and in CI, so `bun install` runs without bash.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const electronApp = join(root, 'node_modules/electron/dist/Electron.app')
const iconSource = join(root, 'resources/icon.icns')

if (process.platform === 'darwin' && !process.env.CI && existsSync(iconSource) && existsSync(electronApp)) {
  copyFileSync(iconSource, join(electronApp, 'Contents/Resources/electron.icns'))
  // A new modification time makes macOS read the bundle icon again.
  const now = new Date()
  utimesSync(electronApp, now, now)
  // Changing the bundle breaks its signature, so sign it again ad hoc.
  spawnSync('codesign', ['--force', '--deep', '--sign', '-', electronApp], { stdio: 'ignore' })
}
