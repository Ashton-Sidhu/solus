import { localApi } from '@solus/client-core/local-api'
import { appMonogram, appTileHue } from '@solus/client-core/app-tile'
import type { NativeSolusAPI } from '@solus/contracts/host-api'
import type { AppSummary } from '@solus/contracts/apps'
import { appShortcutIconKey, isSameAppShortcutTarget, type AppShortcutTarget, type AppShortcutView } from '@solus/contracts/app-shortcuts'
import { appIconsStore, type AppIconsStore } from './app-icons.store.svelte'
import { appShortcutIconPng, type AppShortcutIconSource } from './app-shortcut-icon'

type AppShortcutsApi = Pick<NativeSolusAPI, 'appShortcuts' | 'addAppShortcut' | 'removeAppShortcut' | 'openAppWindow'>
type ShortcutApp = Pick<AppSummary, 'id' | 'name' | 'colorHue' | 'iconHash'>

/** What the launcher's icon of an app is drawn from now (`appShortcutIconKey`). */
function iconKeyOf(app: ShortcutApp, iconHash: string | null = app.iconHash): string {
  return appShortcutIconKey({ iconHash, monogram: appMonogram(app.name), hue: appTileHue(app) })
}

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
    private readonly drawIcon: (source: AppShortcutIconSource) => Promise<ArrayBuffer> = appShortcutIconPng,
    private readonly icons: Pick<AppIconsStore, 'svgFor'> = appIconsStore,
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

  /**
   * Writes the launcher of the app, with its name and its icon: its own
   * `icon.svg`, read from `serverId`, else its tile. An icon that cannot be
   * read gives the tile and the tile's key, so the next open tries it again.
   */
  async add(target: AppShortcutTarget, serverId: string, app: ShortcutApp): Promise<void> {
    const key = `${target.host}\n${target.appId}`
    if (this.writing.has(key)) return
    this.writing.add(key)
    try {
      const svg = await this.icons.svgFor(serverId, app)
      const iconPng = await this.drawIcon({ monogram: appMonogram(app.name), hue: appTileHue(app), svg })
      await this.api.addAppShortcut?.({ ...target, name: app.name, iconPng, iconKey: iconKeyOf(app, svg === null ? null : app.iconHash) })
      await this.reload()
    } finally {
      this.writing.delete(key)
    }
  }

  async remove(target: AppShortcutTarget): Promise<void> {
    await this.api.removeAppShortcut?.(target)
    await this.reload()
  }

  /**
   * A launcher shows the app's name and icon (docs/app-shortcuts.md §4). When
   * the app opens, a launcher with another name, an icon from another key (a
   * new icon.svg, a new colour, a new first letter), or the format of an older
   * Solus is written again. An app that did not change writes nothing.
   */
  async follow(target: AppShortcutTarget, serverId: string, app: ShortcutApp): Promise<void> {
    const shortcut = this.shortcuts.find((candidate) => isSameAppShortcutTarget(candidate, target))
    if (!shortcut) return
    if (shortcut.name !== app.name || shortcut.iconKey !== iconKeyOf(app) || shortcut.isOutdated) await this.add(target, serverId, app)
  }

  async openWindow(target: AppShortcutTarget, name: string): Promise<void> {
    await this.api.openAppWindow?.({ ...target, name })
  }
}

export const appShortcutsStore = new AppShortcutsStore()
