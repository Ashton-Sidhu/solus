import { homedir } from 'os'
import { join } from 'path'
import packageJson from '../../../package.json'
import { getElectronModule } from './electron'

function electronApp(): Electron.App | null {
  return getElectronModule()?.app ?? null
}

export function dataDir(): string {
  const app = electronApp()
  if (app) return app.getPath('userData')
  return process.env.SOLUS_DATA_DIR || join(homedir(), '.solus')
}

/** The shared `.solus` state dir. Unlike dataDir(), identical under Electron and Node. */
export function solusDir(): string {
  return process.env.SOLUS_DATA_DIR || join(homedir(), '.solus')
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
  // The standalone distribution has no Electron `app`, but its generated
  // launchers always set SOLUS_INSTALL_DIR to the package root. Treat that as
  // packaged too so production Node servers do not inherit development-only
  // logging and diagnostics.
  return electronApp()?.isPackaged === true || !!process.env.SOLUS_INSTALL_DIR
}
