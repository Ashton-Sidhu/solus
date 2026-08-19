import { homedir } from 'os'
import { join } from 'path'
import packageJson from '../../../../package.json'
import { platformServices } from './services'

export function dataDir(): string {
  const appInfo = platformServices().appInfo
  if (appInfo) return appInfo.userDataPath
  return process.env.SOLUS_DATA_DIR || join(homedir(), '.solus')
}

/** The shared `.solus` state dir. Unlike dataDir(), identical under Electron and Node. */
export function solusDir(): string {
  return process.env.SOLUS_DATA_DIR || join(homedir(), '.solus')
}

export function logsDir(): string {
  const appInfo = platformServices().appInfo
  if (appInfo) return appInfo.logsPath
  return join(dataDir(), 'logs')
}

/**
 * Root of the app-bundled `resources/` tree, anchored to the app root rather
 * than a module's `__dirname`. The main bundle is code-split, so a module that
 * walks up from its own directory resolves against whichever chunk directory
 * Rollup emitted it into. Electron reports the app root directly (the repo in
 * development, `app.asar` when packaged); the standalone server launchers
 * export SOLUS_INSTALL_DIR. Anything else is an unpackaged run from the repo.
 */
export function bundledResourcesDir(): string {
  const appInfo = platformServices().appInfo
  if (appInfo) return join(appInfo.appPath, 'resources')
  if (process.env.SOLUS_INSTALL_DIR) return join(process.env.SOLUS_INSTALL_DIR, 'resources')
  return join(process.cwd(), 'resources')
}

export function appVersion(): string {
  return platformServices().appInfo?.version ?? packageJson.version
}

export function isPackagedRuntime(): boolean {
  // The standalone distribution has no Electron `app`, but its generated
  // launchers always set SOLUS_INSTALL_DIR to the package root. Treat that as
  // packaged too so production Node servers do not inherit development-only
  // logging and diagnostics.
  return platformServices().appInfo?.isPackaged === true || !!process.env.SOLUS_INSTALL_DIR
}
