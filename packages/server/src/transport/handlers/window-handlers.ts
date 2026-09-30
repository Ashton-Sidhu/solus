import type { SolusServer } from '../server'
import type { AppGlobalShortcuts, SetAppGlobalShortcutsResult } from '@solus/contracts/types'

export interface WindowDeps {
  /** Whether the Solus window is currently visible. */
  isAppVisible(): boolean
  /** Current OS summon shortcuts (desktop-only). */
  getAppGlobalShortcuts(): AppGlobalShortcuts
  /** Apply + persist OS summon shortcuts live; returns accelerators that failed. */
  setAppGlobalShortcuts(shortcuts: AppGlobalShortcuts): SetAppGlobalShortcutsResult
  /** Relaunch the app (fallback when a summon shortcut can't register live). */
  restartApp(): void
}

export function registerWindowHandlers(server: SolusServer, deps: WindowDeps): void {
  server.register('isVisible', () => {
    return deps.isAppVisible()
  })

  server.register('getAppGlobalShortcuts', () => {
    return deps.getAppGlobalShortcuts()
  })

  server.register('setAppGlobalShortcuts', (args) => {
    const [shortcuts] = args
    return deps.setAppGlobalShortcuts(shortcuts)
  })

  server.register('restartApp', () => {
    deps.restartApp()
  })
}
