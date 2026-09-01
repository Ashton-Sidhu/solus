import { existsSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Playwright globalSetup: fail fast if the Electron main bundle hasn't been
 * built. Tests would otherwise hang waiting for `electronApp.firstWindow()`
 * with a cryptic timeout.
 */
export default async function globalSetup() {
  const mainBundle = join(__dirname, '../../dist/main/index.js')
  const preloadBundle = join(__dirname, '../../dist/preload/index.js')
  const rendererHtml = join(__dirname, '../../dist/renderer/index.html')

  const missing = [mainBundle, preloadBundle, rendererHtml].filter((p) => !existsSync(p))
  if (missing.length) {
    const list = missing.map((p) => `  - ${p}`).join('\n')
    throw new Error(
      `e2e tests require a built app. Missing:\n${list}\n\nRun \`bun run build:test\` first.`
    )
  }

  const mainAge = Date.now() - statSync(mainBundle).mtimeMs
  if (mainAge > 24 * 60 * 60 * 1000) {
    console.warn(
      `[e2e] dist/main/index.js is ${Math.round(mainAge / 3600_000)}h old — consider rebuilding.`
    )
  }
}
