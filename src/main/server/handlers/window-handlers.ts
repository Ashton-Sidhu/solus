import type { BrowserWindow } from 'electron'
import type { SolusServer } from '../server'
import type { AppGlobalShortcuts, SetAppGlobalShortcutsResult } from '../../../shared/types'

export interface WindowDeps {
  getMainWindow(): BrowserWindow | null
  applyViewMode(mode: 'pill' | 'editor'): void
  /** Current OS summon shortcuts (desktop-only). */
  getAppGlobalShortcuts(): AppGlobalShortcuts
  /** Apply + persist OS summon shortcuts live; returns accelerators that failed. */
  setAppGlobalShortcuts(shortcuts: AppGlobalShortcuts): SetAppGlobalShortcutsResult
  /** Relaunch the app (fallback when a summon shortcut can't register live). */
  restartApp(): void
}

export function registerWindowHandlers(server: SolusServer, deps: WindowDeps): void {
  server.register('isVisible', () => {
    return deps.getMainWindow()?.isVisible() ?? false
  })

  server.register('notifyViewMode', (args) => {
    const [mode] = args as ['pill' | 'editor']
    deps.applyViewMode(mode)
  })

  server.register('getAppGlobalShortcuts', () => {
    return deps.getAppGlobalShortcuts()
  })

  server.register('setAppGlobalShortcuts', (args) => {
    const [shortcuts] = args as [AppGlobalShortcuts]
    return deps.setAppGlobalShortcuts(shortcuts)
  })

  server.register('restartApp', () => {
    deps.restartApp()
  })
}
