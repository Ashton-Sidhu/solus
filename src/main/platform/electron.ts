import { createRequire } from 'module'

const require = createRequire(import.meta.url)

let electronModule: typeof import('electron') | null | undefined

export function getElectronModule(): typeof import('electron') | null {
  if (!process.versions.electron) return null
  if (electronModule !== undefined) return electronModule
  try {
    // SAFETY: Electron's package entry exports the public module contract declared by its bundled types.
    electronModule = require('electron') as typeof import('electron')
  } catch {
    electronModule = null
  }
  return electronModule
}
