import { ipcMain, nativeImage } from 'electron'
import { z } from 'zod'
import { createLogger } from '@solus/server/logger'
import { isAppShortcutTarget, type AppShortcutTarget, type AppShortcutView } from '@solus/contracts/app-shortcuts'
import type { AppShortcutRecords } from './app-shortcut-records'
import type { AppWindows } from './app-windows'
import type { AppLaunchers } from './launchers'

const log = createLogger('main', 'app-shortcuts')

/** The tile is one flat colour and one letter: a PNG of it is far below this. */
const MAX_ICON_BYTES = 2 * 1024 * 1024

const targetSchema = z.object({ host: z.string(), appId: z.string() }).refine(isAppShortcutTarget)
const windowRequestSchema = z.object({ host: z.string(), appId: z.string(), name: z.string().max(200) }).refine(isAppShortcutTarget)
const shortcutRequestSchema = z.object({
  host: z.string(),
  appId: z.string(),
  name: z.string().min(1).max(200),
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
    records.list().map(({ host, appId, name }) => ({ host, appId, name })))

  ipcMain.handle('solus:app-shortcut-add', async (_event, rawRequest) => {
    const { host, appId, name, iconPng } = shortcutRequestSchema.parse(rawRequest)
    const tile = nativeImage.createFromBuffer(Buffer.from(iconPng))
    if (tile.isEmpty()) throw new Error('The icon of the shortcut is not an image.')
    const target = { host, appId }
    const launcherPath = await launchers.write({
      target,
      name,
      iconPng: (size) => tile.resize({ width: size, height: size, quality: 'best' }).toPNG(),
      previousPath: records.find(target)?.launcherPath ?? null,
    })
    records.save({ host, appId, name, launcherPath })
    log.info('app_shortcut_added', { appId, host })
  })

  ipcMain.handle('solus:app-shortcut-remove', (_event, rawTarget) => removeAppShortcut({ records, launchers }, targetSchema.parse(rawTarget)))

  ipcMain.handle('solus:app-window-open', (_event, rawRequest) => {
    windows.open(windowRequestSchema.parse(rawRequest))
  })
}

/** Removes the launcher and the record of one app's shortcut. The app menu of its window removes it too. */
export async function removeAppShortcut({ records, launchers }: Pick<AppShortcutIpcDeps, 'records' | 'launchers'>, target: AppShortcutTarget): Promise<void> {
  const record = records.find(target)
  if (!record) return
  await launchers.remove(target, record.launcherPath)
  records.remove(target)
  log.info('app_shortcut_removed', { appId: target.appId, host: target.host })
}
