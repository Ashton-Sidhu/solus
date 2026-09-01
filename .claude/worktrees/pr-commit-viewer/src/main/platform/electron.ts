import { createRequire } from 'module'

const require = createRequire(typeof import.meta.url === 'string' ? import.meta.url : __filename)

let electronModule: typeof import('electron') | null | undefined

export function getElectronModule(): typeof import('electron') | null {
  if (!process.versions.electron) return null
  if (electronModule !== undefined) return electronModule
  try {
    electronModule = require('electron') as typeof import('electron')
  } catch {
    electronModule = null
  }
  return electronModule
}
