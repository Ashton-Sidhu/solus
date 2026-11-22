import { ACCOUNT_THEME_COOKIE, LEGACY_THEME_COOKIE, legacyAccountTheme } from '@solus/contracts/account-web'
import { accountSyncStore } from '@solus/workspace-ui/contexts/account/account-sync.store.svelte'
import type { SettingsContext } from '@solus/workspace-ui/contexts/app/settings.context.svelte'
import { cloudAccount } from '@solus/client-core/cloud-account'

/** Account settings own the theme. The cookie lets Cloud paint its HTML before hydration. */
export function followAccountTheme(settings: SettingsContext): void {
  $effect(() => {
    if (!cloudAccount()) return
    const state = accountSyncStore.settings.state
    if (state !== 'synced' && state !== 'pending') return
    const cookies = document.cookie.split('; ').map((entry) => entry.split('='))
    const previous = cookies.find(([name]) => name === LEGACY_THEME_COOKIE)?.[1]
    const mirror = cookies.find(([name]) => name === ACCOUNT_THEME_COOKIE)?.[1]
    const mode = settings.themeMode
    if (!mirror && previous) {
      const legacy = legacyAccountTheme(previous, mirror, settings.personal.storedDocument.themeMode)
      if (legacy) {
        if (state === 'synced') settings.setPersonal('themeMode', legacy)
        return
      }
    }
    if (mirror !== mode) document.cookie = `${ACCOUNT_THEME_COOKIE}=${mode}; Path=/; Max-Age=31536000; SameSite=Lax`
    if (previous) document.cookie = `${LEGACY_THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
  })
}
