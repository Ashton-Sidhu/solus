import { setAnalyticsConsent } from '../settings'
import type { SolusServer } from '../server'

export function registerSettingsHandlers(server: SolusServer): void {
  server.register('setAnalyticsConsent', (args) => {
    const [enabled] = args as [boolean]
    setAnalyticsConsent(enabled === true)
  })
}
