import { homedir } from 'os'
import { join } from 'path'
import packageJson from '../../../package.json'
import { getElectronModule } from './electron'

type ElectronApp = {
  getPath(name: string): string
  getVersion(): string
  isPackaged?: boolean
}

function electronApp(): ElectronApp | null {
  const app = getElectronModule()?.app
  if (!app || typeof app !== 'object') return null
  const candidate = app as Partial<ElectronApp>
  if (typeof candidate.getPath !== 'function') return null
  return candidate as ElectronApp
}

export function dataDir(): string {
  const app = electronApp()
  if (app) return app.getPath('userData')
  return process.env.SOLUS_DATA_DIR ?? join(homedir(), '.solus')
}

export function logsDir(): string {
  const app = electronApp()
  if (app) return app.getPath('logs')
  return join(dataDir(), 'logs')
}

export function appVersion(): string {
  return electronApp()?.getVersion?.() ?? packageJson.version
}

export function isPackagedRuntime(): boolean {
  return electronApp()?.isPackaged === true
}
