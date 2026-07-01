import { nativeTheme } from 'electron'
import type { SolusServer } from '../server'

export function registerThemeHandlers(server: SolusServer): void {
  server.register('getTheme', () => {
    return { isDark: nativeTheme.shouldUseDarkColors }
  })
}
