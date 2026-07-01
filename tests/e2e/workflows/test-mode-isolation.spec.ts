import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

test.describe('Test-mode isolation', () => {
  test('window stays hidden and no global shortcuts are registered', async ({ electronApp, page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    const isVisible = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return win?.isVisible() ?? false
    })
    expect(isVisible).toBe(false)

    const hasShortcuts = await electronApp.evaluate(({ globalShortcut }) => {
      return globalShortcut.isRegistered('Alt+Space')
        || globalShortcut.isRegistered('CommandOrControl+Shift+K')
    })
    expect(hasShortcuts).toBe(false)
  })
})
