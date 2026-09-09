import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app, ipcMain } from 'electron'
import { z } from 'zod'
import type { DesktopUpdateStatus } from '@solus/contracts/desktop-update-types'
import { createLogger } from '@solus/server/logger'
import { reduceUpdateState, releaseFromUpdateInfo, type UpdateEvent } from './update-status'

const log = createLogger('main', 'updates/ipc.ts')
const requireCjs = createRequire(import.meta.url)

export const UPDATE_CHANNELS = {
  status: 'solus:update-status',
  check: 'solus:update-check',
  download: 'solus:update-download',
  restart: 'solus:update-restart',
  setAutoDownload: 'solus:update-set-auto-download',
  statusChanged: 'solus:update-status-changed',
} as const

import { FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS } from '@solus/contracts/update-cadence'

const settingsSchema = z.object({ autoDownload: z.boolean() })
type UpdateSettings = z.infer<typeof settingsSchema>
const DEFAULT_SETTINGS: UpdateSettings = { autoDownload: true }

function settingsPath(): string {
  return join(app.getPath('userData'), 'updates.json')
}

function loadSettings(): UpdateSettings {
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(settingsPath(), 'utf-8')))
    if (parsed.success) return parsed.data
  } catch {}
  return DEFAULT_SETTINGS
}

function saveSettings(settings: UpdateSettings): void {
  try {
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 })
  } catch (err) {
    log.error('update_settings_save_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

type AutoUpdater = typeof import('electron-updater').autoUpdater

export interface UpdateIpc {
  /** Quit and install a ready update; a no-op in any other state. */
  restartToUpdate(): void
}

interface UpdateIpcDeps {
  broadcast(channel: string, status: DesktopUpdateStatus): void
  /** Runs before quit-and-install so window close handlers let the app quit. */
  onBeforeQuitAndInstall(): void
  /** Every status change, for main-process surfaces such as the tray. */
  onStatusChange?(status: DesktopUpdateStatus): void
}

/**
 * Owns the desktop update status: runs the checks, drives `electron-updater`,
 * holds the auto-download setting, and answers the renderer over IPC. The
 * renderer never talks to the feed. `docs/plans/desktop-updates.md`.
 *
 * `electron-updater` is loaded lazily and with `require`, not `import()`. It was
 * the single most expensive eager require in the main process, so it stays off
 * the path to the first window. And the package is CommonJS with an
 * arrow-function getter for `autoUpdater`, which Node's CJS export detection
 * cannot see: an ESM `import()` yields no `autoUpdater` binding at all.
 */
export function registerUpdateIpc(deps: UpdateIpcDeps): UpdateIpc {
  let status: DesktopUpdateStatus = {
    currentVersion: app.getVersion(),
    autoDownload: loadSettings().autoDownload,
    state: { kind: 'idle' },
  }
  let updater: AutoUpdater | null = null

  const publish = (next: DesktopUpdateStatus): void => {
    status = next
    deps.broadcast(UPDATE_CHANNELS.statusChanged, status)
    deps.onStatusChange?.(status)
  }
  const apply = (event: UpdateEvent): void => {
    const state = reduceUpdateState(status.state, event)
    if (state === status.state) return
    log.info('update_state_changed', { from: status.state.kind, to: state.kind })
    publish({ ...status, state })
  }

  const loadUpdater = (): AutoUpdater | null => {
    if (updater) return updater
    if (!app.isPackaged) return null
    try {
      // SAFETY: `require` returns the package's real CommonJS exports object,
      // whose shape is the one its own type declarations describe.
      const { autoUpdater } = requireCjs('electron-updater') as typeof import('electron-updater')
      autoUpdater.logger = {
        info: (msg: string) => log.info('electron_updater_log', { message: msg }),
        warn: (msg: string) => log.warn('electron_updater_log', { message: msg }),
        error: (msg: string) => log.error('electron_updater_log', { message: msg }),
        debug: (msg: string) => log.debug('electron_updater_log', { message: msg }),
      }
      autoUpdater.autoDownload = status.autoDownload
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.on('checking-for-update', () => apply({ type: 'checking' }))
      autoUpdater.on('update-not-available', () => apply({ type: 'not-available', at: Date.now() }))
      autoUpdater.on('update-available', (info) => {
        apply({ type: 'available', release: releaseFromUpdateInfo(info) })
        if (status.autoDownload) apply({ type: 'download-started' })
      })
      autoUpdater.on('download-progress', (progress) => apply({ type: 'progress', percent: progress.percent }))
      autoUpdater.on('update-downloaded', (info) => apply({ type: 'downloaded', release: releaseFromUpdateInfo(info) }))
      autoUpdater.on('error', (err) => apply({ type: 'error', message: err.message }))
      updater = autoUpdater
      return updater
    } catch (err) {
      log.error('auto_updater_load_failed', { error: err instanceof Error ? err.message : String(err) })
      apply({ type: 'error', message: 'The updater could not be loaded.' })
      return null
    }
  }

  const check = async (): Promise<void> => {
    const instance = loadUpdater()
    if (!instance) {
      if (!app.isPackaged) apply({ type: 'error', message: 'Updates run only in the packaged app.' })
      return
    }
    if (status.state.kind === 'ready') return
    try {
      await instance.checkForUpdates()
    } catch (err) {
      // `error` on the updater already moved the state; this is the same failure.
      log.warn('update_check_failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  const download = async (): Promise<void> => {
    const instance = loadUpdater()
    if (!instance || status.state.kind !== 'available') return
    apply({ type: 'download-started' })
    try {
      await instance.downloadUpdate()
    } catch (err) {
      log.warn('update_download_failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  const restart = (): void => {
    if (!updater || status.state.kind !== 'ready') return
    log.info('update_restart_requested', { version: status.state.release.version })
    // Set forceQuit before quitAndInstall so the window close handler doesn't
    // call e.preventDefault() + hide() — on macOS the close event can fire
    // before before-quit, which hides the UI and blocks the actual quit.
    deps.onBeforeQuitAndInstall()
    updater.quitAndInstall(true, true)
    setTimeout(() => app.exit(0), 3000)
  }

  ipcMain.handle(UPDATE_CHANNELS.status, () => status)
  ipcMain.handle(UPDATE_CHANNELS.check, () => check())
  ipcMain.handle(UPDATE_CHANNELS.download, () => download())
  ipcMain.on(UPDATE_CHANNELS.restart, () => restart())
  ipcMain.handle(UPDATE_CHANNELS.setAutoDownload, (_event, raw) => {
    const enabled = z.boolean().parse(raw)
    saveSettings({ autoDownload: enabled })
    if (updater) updater.autoDownload = enabled
    publish({ ...status, autoDownload: enabled })
    // Turning the setting on while an update is waiting is a request to fetch it.
    if (enabled && status.state.kind === 'available') void download()
  })

  if (!app.isPackaged) {
    log.info('auto_updater_skipped_dev')
  } else {
    setTimeout(() => void check(), FIRST_CHECK_DELAY_MS)
    setInterval(() => void check(), CHECK_INTERVAL_MS)
  }
  return { restartToUpdate: restart }
}
