import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

test.use({ verifyErrors: true })

test('isolated native shell stays hidden without global shortcuts', async ({ electronApp, page }) => {
  await new AppPage(page).waitForAppReady()
  expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isVisible()))).toBe(true)
  expect(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+Space'))).toBe(false)
})

test('desktop IPC prompt completes', async ({ page }) => {
  const app = new AppPage(page)
  await app.waitForAppReady()
  const editor = page.locator('[data-testid="message-input"]:visible').first()
  await editor.getByRole('textbox').click()
  await page.keyboard.type('QA native prompt')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-testid="assistant-message"]:visible').last()).toContainText('This is a mock response')
})
