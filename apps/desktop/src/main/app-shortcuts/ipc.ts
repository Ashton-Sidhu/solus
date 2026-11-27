import { ipcMain, nativeImage } from 'electron'
import { z } from 'zod'
import { createLogger } from '@solus/server/logger'
import { isAppShortcutTarget, type AppShortcutView } from '@solus/contracts/app-shortcuts'
import { LAUNCHER_FORMAT, appShortcutView, type AppShortcutRecords } from './app-shortcut-records'
import type { AppWindows } from './app-windows'
import type { AppLaunchers } from './launchers'

const log = createLogger('main', 'app-shortcuts')

/** The icon is one PNG of 1024 pixels: a PNG of the monogram or of a plain SVG is far below this. */
const MAX_ICON_BYTES = 2 * 1024 * 1024

const targetSchema = z.object({ host: z.string(), appId: z.string() }).refine(isAppShortcutTarget)
const windowRequestSchema = z.object({ host: z.string(), appId: z.string(), name: z.string().max(200) }).refine(isAppShortcutTarget)
const shortcutRequestSchema = z.object({
  host: z.string(),
  appId: z.string(),
  name: z.string().min(1).max(200),
  iconKey: z.string().max(200),
  iconPng: z.instanceof(ArrayBuffer).refine((data) => data.byteLength > 0 && data.byteLength <= MAX_ICON_BYTES),
}).refine(isAppShortcutTarget)

export interface AppShortcutIpcDeps {
  records: AppShortcutRecords
  launchers: AppLaunchers
  windows: AppWindows
}

/**
 * The renderer's commands for app shortcuts and app windows. Native, not RPC:
 * a launcher is a file of this computer, and the app can live on any host.
 */
export function registerAppShortcutIpc({ records, launchers, windows }: AppShortcutIpcDeps): void {
  ipcMain.handle('solus:app-shortcuts', (): AppShortcutView[] =>
    records.list().map(appShortcutView))

  ipcMain.handle('solus:app-shortcut-add', async (_event, rawRequest) => {
    const { host, appId, name, iconKey, iconPng } = shortcutRequestSchema.parse(rawRequest)
    const tile = nativeImage.createFromBuffer(Buffer.from(iconPng))
    if (tile.isEmpty()) throw new Error('The icon of the shortcut is not an image.')
    const target = { host, appId }
    const launcherPath = await launchers.write({
      target,
      name,
      iconPng: (size) => tile.resize({ width: size, height: size, quality: 'best' }).toPNG(),
      previousPath: records.find(target)?.launcherPath ?? null,
    })
    records.save({ host, appId, name, launcherPath, iconKey, launcherFormat: LAUNCHER_FORMAT })
    // An open window of the app takes the new icon at once (Windows and Linux).
    windows.showIdentity(target, name)
    log.info('app_shortcut_written', { appId, host, iconKey })
  })

  ipcMain.handle('solus:app-shortcut-remove', async (_event, rawTarget) => {
    const target = targetSchema.parse(rawTarget)
    const record = records.find(target)
    if (!record) return
    await launchers.remove(target, record.launcherPath)
    records.remove(target)
    log.info('app_shortcut_removed', { appId: target.appId, host: target.host })
  })

  ipcMain.handle('solus:app-window-open', (_event, rawRequest) => {
    windows.open(windowRequestSchema.parse(rawRequest))
  })
}
