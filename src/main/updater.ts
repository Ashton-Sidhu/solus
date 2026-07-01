import { autoUpdater } from 'electron-updater'
import { app, dialog } from 'electron'
import { createLogger } from './logger'

const log = createLogger('main', 'updater.ts')

export function initAutoUpdater(onBeforeQuitAndInstall?: () => void): void {
  if (!app.isPackaged) {
    log.info('Skipping auto-updater in development mode')
    return
  }

  autoUpdater.logger = {
    info: (msg: string) => log.info(msg),
    warn: (msg: string) => log.warn(msg),
    error: (msg: string) => log.error(msg),
    debug: (msg: string) => log.debug(msg),
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', async (info) => {
    log.info(`Update available: ${info.version}`)
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `Solus ${info.version} is available.`,
      detail: 'Would you like to download and install it? The app will restart after the update.',
      buttons: ['Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      autoUpdater.downloadUpdate()
    }
  })

  autoUpdater.on('update-downloaded', async (info) => {
    log.info(`Update downloaded: ${info.version}`)
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Solus ${info.version} has been downloaded.`,
      detail: 'Restart now to apply the update?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      // Set forceQuit before quitAndInstall so the window close handler doesn't
      // call e.preventDefault() + hide() — on macOS the close event can fire
      // before before-quit, which hides the UI and blocks the actual quit.
      onBeforeQuitAndInstall?.()
      autoUpdater.quitAndInstall(true, true)
      setTimeout(() => app.exit(0), 3000)
    }
  })

  autoUpdater.on('error', (err) => {
    log.error(`Auto-updater error: ${err.message}`)
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn(`Update check failed: ${err.message}`)
    })
  }, 10_000)

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn(`Periodic update check failed: ${err.message}`)
    })
  }, 4 * 60 * 60 * 1000)
}
