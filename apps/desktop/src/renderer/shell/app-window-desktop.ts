import { localApi } from '@solus/client-core/local-api'
import { AppCallFailure, type AppFrameDesktop } from '@solus/client-core/app-calls'
import { desktopUnavailable } from '@solus/contracts/app-desktop'

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
