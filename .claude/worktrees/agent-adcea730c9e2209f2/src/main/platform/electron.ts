import { createRequire } from 'module'

const require = createRequire(typeof import.meta.url === 'string' ? import.meta.url : __filename)

let electronModule: Record<string, unknown> | null | undefined

export function getElectronModule(): Record<string, unknown> | null {
  if (!process.versions.electron) return null
  if (electronModule !== undefined) return electronModule
  try {
    electronModule = require('electron') as Record<string, unknown>
  } catch {
    electronModule = null
  }
  return electronModule
}
