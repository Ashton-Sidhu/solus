import { localApi } from '@solus/client-core/local-api'
import { AppCallFailure, type AppFrameDesktop } from '@solus/client-core/app-calls'
import { appMonogram, appTileHue } from '@solus/client-core/app-tile'
import { desktopUnavailable } from '@solus/contracts/app-desktop'
import type { AppMenuBarPage, AppSummary } from '@solus/contracts/apps'
import { appIconsStore } from '@solus/workspace-ui/contexts/apps/app-icons.store.svelte'
import { appShortcutIconPng } from '@solus/workspace-ui/contexts/apps/app-shortcut-icon'

/**
 * The desktop capabilities that an app window gives the frame of its app
 * (docs/plans/app-desktop-capabilities.md §3). The main process names the
 * app from this window, so the page cannot act for another app.
 */
export const appWindowDesktop: AppFrameDesktop = {
  async call(operation, args) {
    const result = (await localApi.appDesktopCall?.(operation, args)) ?? { ok: false, failure: desktopUnavailable() }
    if (!result.ok) throw new AppCallFailure(result.failure)
    return result.value
  },
  subscribe: (listener) => localApi.onAppDesktopEvent?.(listener) ?? (() => {}),
}

type ReportedApp = Pick<AppSummary, 'id' | 'name' | 'colorHue' | 'iconHash'>

/**
 * What the main process keeps of the app in this window
 * (docs/plans/app-desktop-capabilities.md §9): whether its active version has
 * a menu-bar page, with its size, and its icon, which its menu-bar item shows
 * on every system. Each is sent again only when it changes.
 */
export function createAppWindowReport(api: Pick<typeof localApi, 'setAppMenuBarPage' | 'setAppWindowIcon'> = localApi) {
  let sentPage: string | null = null
  let sentIcon: string | null = null
  return {
    menuBarPage(page: AppMenuBarPage | null): void {
      const key = page ? `${page.width}x${page.height}` : 'none'
      if (key === sentPage) return
      sentPage = key
      api.setAppMenuBarPage?.(page)
    },
    async icon(serverId: string, app: ReportedApp): Promise<void> {
      if (!api.setAppWindowIcon) return
      const key = `${app.iconHash ?? ''}\n${app.name}\n${appTileHue(app)}`
      if (key === sentIcon) return
      sentIcon = key
      const svg = await appIconsStore.svgFor(serverId, app).catch(() => null)
      const png = await appShortcutIconPng({ monogram: appMonogram(app.name), hue: appTileHue(app), svg })
      api.setAppWindowIcon(new Uint8Array(png))
    },
  }
}
