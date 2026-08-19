import { autoUpdater } from 'electron-updater'
import { app, dialog } from 'electron'
import { createLogger } from '@solus/server/logger'

const log = createLogger('main', 'updater.ts')

export function initAutoUpdater(onBeforeQuitAndInstall?: () => void): void {
  if (!app.isPackaged) {
    log.info('auto_updater_skipped_dev')
    return
  }

  autoUpdater.logger = {
    info: (msg: string) => log.info('electron_updater_log', { message: msg }),
    warn: (msg: string) => log.warn('electron_updater_log', { message: msg }),
    error: (msg: string) => log.error('electron_updater_log', { message: msg }),
    debug: (msg: string) => log.debug('electron_updater_log', { message: msg }),
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', async (info) => {
    log.info('update_available', { version: info.version })
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
    log.info('update_downloaded', { version: info.version })
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
    log.error('auto_updater_error', { error: err.message })
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn('update_check_failed', { error: err.message })
    })
  }, 10_000)

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn('periodic_update_check_failed', { error: err.message })
    })
  }, 4 * 60 * 60 * 1000)
}
