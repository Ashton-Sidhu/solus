import { SvelteMap } from 'svelte/reactivity'
import { localApi } from '@solus/client-core/local-api'
import { appMonogram, appTileHue } from '@solus/client-core/app-tile'
import type { NativeSolusAPI } from '@solus/contracts/host-api'
import type { AppSummary } from '@solus/contracts/apps'
import {
  appShortcutIconKey,
  isSameAppShortcutTarget,
  type AppShortcutRemoval,
  type AppShortcutTarget,
  type AppShortcutView,
} from '@solus/contracts/app-shortcuts'
import { appIconsStore, type AppIconsStore } from './app-icons.store.svelte'
import { appShortcutIconPng, type AppShortcutIconSource } from './app-shortcut-icon'

type AppShortcutsApi = Pick<NativeSolusAPI, 'appShortcuts' | 'addAppShortcut' | 'removeAppShortcut' | 'openAppWindow'>
type ShortcutApp = Pick<AppSummary, 'id' | 'name' | 'colorHue' | 'iconHash'>

/** What the launcher's icon of an app is drawn from now (`appShortcutIconKey`). */
function iconKeyOf(app: ShortcutApp, iconHash: string | null = app.iconHash): string {
  return appShortcutIconKey({ iconHash, monogram: appMonogram(app.name), hue: appTileHue(app) })
}

/** The change that runs now on the shortcut of one app. A rename writes the launcher again ("updating"). */
export type AppShortcutChange = 'adding' | 'removing' | 'updating'

/** What a removal of several shortcuts did, for the message that follows it. */
export interface AppShortcutsRemoval {
  /** The shortcuts that have no record now. */
  removed: AppShortcutView[]
  /** Of those, the launchers that the Trash refused: they stay and still open their apps. */
  kept: Array<{ shortcut: AppShortcutView; launcherPath: string }>
  /** The shortcuts that are still there, with what went wrong. */
  failed: Array<{ shortcut: AppShortcutView; message: string }>
}

function shortcutKey(target: AppShortcutTarget): string {
  return `${target.host}\n${target.appId}`
}

/**
 * The app shortcuts of this device and the command that opens an app window
 * (docs/app-shortcuts.md). The desktop app's main process owns both, because
 * a launcher is a file of this computer; this store mirrors its list and the
 * change that runs on each shortcut, so every surface shows the same state.
 * On web and mobile there is no such capability: `isAvailable` is false and
 * no surface shows a shortcut command.
 */
export class AppShortcutsStore {
  private shortcuts = $state<AppShortcutView[]>([])
  /** Why the last read of the list failed. Until a read succeeds, an empty list is not an answer. */
  private readError = $state<string | null>(null)
  /** True when the client shell can open app windows and write launchers (desktop). */
  readonly isAvailable: boolean
  private firstRead: Promise<void> | null = null
  /** The change that runs on each app's shortcut. A second command for the same app waits for none: it does nothing. */
  private readonly changes = new SvelteMap<string, AppShortcutChange>()

  constructor(
    private readonly api: Partial<AppShortcutsApi> = localApi,
    private readonly drawIcon: (source: AppShortcutIconSource) => Promise<ArrayBuffer> = appShortcutIconPng,
    private readonly icons: Pick<AppIconsStore, 'svgFor'> = appIconsStore,
  ) {
    this.isAvailable = api.appShortcuts !== undefined
  }

  /** Reads the list once; safe to call from each surface that shows a shortcut command. */
  start(): void {
    void this.loaded()
  }

  /** The first read of the list, for a command that needs the list before it acts. A failed read leaves `listError`. */
  loaded(): Promise<void> {
    if (!this.isAvailable) return Promise.resolve()
    this.firstRead ??= this.reload().catch(() => {})
    return this.firstRead
  }

  private async reload(): Promise<void> {
    try {
      this.shortcuts = (await this.api.appShortcuts?.()) ?? []
      this.readError = null
    } catch (error) {
      this.readError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /** Reads the list again after a read failed. */
  async checkAgain(): Promise<void> {
    await this.reload().catch(() => {})
  }

  /** Why the list could not be read, or null when it was. */
  get listError(): string | null {
    return this.readError
  }

  /** The shortcuts of this computer, in the order they were added. */
  get list(): readonly AppShortcutView[] {
    return this.shortcuts
  }

  /** The shortcuts of the apps of one host, by its installation id. */
  ofHost(host: string): AppShortcutView[] {
    return this.shortcuts.filter((shortcut) => shortcut.host === host)
  }

  has(target: AppShortcutTarget): boolean {
    return this.shortcuts.some((shortcut) => isSameAppShortcutTarget(shortcut, target))
  }

  /** The change that runs now on the app's shortcut, or null. */
  changeFor(target: AppShortcutTarget): AppShortcutChange | null {
    return this.changes.get(shortcutKey(target)) ?? null
  }

  /** Runs one change on one app's shortcut. Null when another change of it runs, so a second click does nothing. */
  private async change<Result>(target: AppShortcutTarget, change: AppShortcutChange, action: () => Promise<Result>): Promise<Result | null> {
    const key = shortcutKey(target)
    if (this.changes.has(key)) return null
    this.changes.set(key, change)
    try {
      return await action()
    } finally {
      this.changes.delete(key)
    }
  }

  /**
   * Writes the launcher of the app, with its name and its icon: its own
   * `icon.svg`, read from `serverId`, else its tile. An icon that cannot be
   * read gives the tile and the tile's key, so the next open tries it again.
   */
  private async write(target: AppShortcutTarget, serverId: string, app: ShortcutApp): Promise<void> {
    const svg = await this.icons.svgFor(serverId, app)
    const iconPng = await this.drawIcon({ monogram: appMonogram(app.name), hue: appTileHue(app), svg })
    await this.api.addAppShortcut?.({ ...target, name: app.name, iconPng, iconKey: iconKeyOf(app, svg === null ? null : app.iconHash) })
    await this.reload()
  }

  /** Writes the launcher of the app, with its name and its icon (`write`). */
  async add(target: AppShortcutTarget, serverId: string, app: ShortcutApp): Promise<void> {
    await this.change(target, 'adding', () => this.write(target, serverId, app))
  }

  /** Removes the shortcut. Null when another change of it runs. */
  async remove(target: AppShortcutTarget): Promise<AppShortcutRemoval | null> {
    return this.change(target, 'removing', async () => {
      const removal = (await this.api.removeAppShortcut?.(target)) ?? { launcher: 'removed' as const }
      await this.reload()
      return removal
    })
  }

  /**
   * Removes each shortcut and reads the list once after. One that fails does
   * not stop the others: the answer names it.
   */
  async removeMany(shortcuts: readonly AppShortcutView[]): Promise<AppShortcutsRemoval> {
    const result: AppShortcutsRemoval = { removed: [], kept: [], failed: [] }
    for (const shortcut of shortcuts) {
      const key = shortcutKey(shortcut)
      if (this.changes.has(key)) {
        result.failed.push({ shortcut, message: 'Another change of this shortcut runs now.' })
        continue
      }
      this.changes.set(key, 'removing')
      try {
        const removal = (await this.api.removeAppShortcut?.(shortcut)) ?? { launcher: 'removed' as const }
        result.removed.push(shortcut)
        if (removal.launcher === 'kept') result.kept.push({ shortcut, launcherPath: removal.launcherPath })
      } catch (error) {
        result.failed.push({ shortcut, message: error instanceof Error ? error.message : String(error) })
      } finally {
        this.changes.delete(key)
      }
    }
    await this.reload()
    return result
  }

  /**
   * A launcher shows the app's name and icon (docs/app-shortcuts.md §4). When
   * the app opens, a launcher with another name, an icon from another key (a
   * new icon.svg, a new colour, a new first letter), or the format of an older
   * Solus is written again ("updating"). An app that did not change writes nothing.
   */
  async follow(target: AppShortcutTarget, serverId: string, app: ShortcutApp): Promise<void> {
    const shortcut = this.shortcuts.find((candidate) => isSameAppShortcutTarget(candidate, target))
    if (!shortcut) return
    if (shortcut.name !== app.name || shortcut.iconKey !== iconKeyOf(app) || shortcut.isOutdated) {
      await this.change(target, 'updating', () => this.write(target, serverId, app))
    }
  }

  async openWindow(target: AppShortcutTarget, name: string): Promise<void> {
    await this.api.openAppWindow?.({ ...target, name })
  }
}

export const appShortcutsStore = new AppShortcutsStore()
