import { localApi } from '@solus/client-core/local-api'
import { appMonogram, appTileHue } from '@solus/client-core/app-tile'
import type { NativeSolusAPI } from '@solus/contracts/host-api'
import type { AppSummary } from '@solus/contracts/apps'
import { isSameAppShortcutTarget, type AppShortcutTarget, type AppShortcutView } from '@solus/contracts/app-shortcuts'
import { appShortcutIconPng } from './app-shortcut-icon'

type AppShortcutsApi = Pick<NativeSolusAPI, 'appShortcuts' | 'addAppShortcut' | 'removeAppShortcut' | 'openAppWindow'>
type ShortcutApp = Pick<AppSummary, 'id' | 'name' | 'colorHue'>

/**
 * The app shortcuts of this device and the command that opens an app window
 * (docs/app-shortcuts.md). The desktop app's main process owns both, because
 * a launcher is a file of this computer; this store mirrors its list. On web
 * and mobile there is no such capability: `isAvailable` is false and no
 * surface shows a shortcut command.
 */
export class AppShortcutsStore {
  private shortcuts = $state<AppShortcutView[]>([])
  /** True when the client shell can open app windows and write launchers (desktop). */
  readonly isAvailable: boolean
  private hasStarted = false
  /** Apps whose launcher is written now, so a rename is not written twice. */
  private readonly writing = new Set<string>()

  constructor(
    private readonly api: Partial<AppShortcutsApi> = localApi,
    private readonly drawIcon: (monogram: string, hue: number) => Promise<ArrayBuffer> = appShortcutIconPng,
  ) {
    this.isAvailable = api.appShortcuts !== undefined
  }

  /** Reads the list once; safe to call from each surface that shows a shortcut command. */
  start(): void {
    if (this.hasStarted || !this.isAvailable) return
    this.hasStarted = true
    void this.reload()
  }

  private async reload(): Promise<void> {
    this.shortcuts = (await this.api.appShortcuts?.()) ?? []
  }

  has(target: AppShortcutTarget): boolean {
    return this.shortcuts.some((shortcut) => isSameAppShortcutTarget(shortcut, target))
  }

  /** Writes the launcher of the app, with its name and its tile as the icon. */
  async add(target: AppShortcutTarget, app: ShortcutApp): Promise<void> {
    const key = `${target.host}\n${target.appId}`
    if (this.writing.has(key)) return
    this.writing.add(key)
    try {
      const iconPng = await this.drawIcon(appMonogram(app.name), appTileHue(app))
      await this.api.addAppShortcut?.({ ...target, name: app.name, iconPng })
      await this.reload()
    } finally {
      this.writing.delete(key)
    }
  }

  async remove(target: AppShortcutTarget): Promise<void> {
    await this.api.removeAppShortcut?.(target)
    await this.reload()
  }

  /** A launcher shows the app's name. After a rename on the host, the launcher is written again with the new name. */
  async followName(target: AppShortcutTarget, app: ShortcutApp): Promise<void> {
    const shortcut = this.shortcuts.find((candidate) => isSameAppShortcutTarget(candidate, target))
    if (shortcut && shortcut.name !== app.name) await this.add(target, app)
  }

  async openWindow(target: AppShortcutTarget, name: string): Promise<void> {
    await this.api.openAppWindow?.({ ...target, name })
  }
}

export const appShortcutsStore = new AppShortcutsStore()
