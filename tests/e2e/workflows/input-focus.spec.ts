import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const MESSAGE_INPUT = `${ACTIVE_SHELL} [data-testid="message-input"]`

async function expectMessageInputFocused(page: import('@playwright/test').Page) {
  await expect(async () => {
    const focused = await page.evaluate((selector) => {
      const input = document.querySelector(selector)
      const active = document.activeElement
      return !!input && !!active && input.contains(active)
    }, MESSAGE_INPUT)
    expect(focused).toBe(true)
  }).toPass({ timeout: 3000 })
}

test.describe('Input focus behavior', () => {
  test('message input is reachable by accessible name', async ({ page }) => {
    // WHY: the primary composer must be discoverable to screen readers by
    // role and name, independent of the visual placeholder layer.
    const app = new AppPage(page)
    await app.waitForAppReady()

    const messageInput = page.locator(MESSAGE_INPUT)
    await expect(messageInput.getByRole('textbox', { name: /message/i })).toBeVisible()
  })

  test('focus request places the caret at the end of an existing draft', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    const editor = page.locator(`${MESSAGE_INPUT} .cm-content`)
    await editor.click()
    await page.keyboard.type('existing draft')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('solus:focus-input')))
    await expectMessageInputFocused(page)
    await page.keyboard.type('!')

    await expect(editor).toHaveText('existing draft!')
  })

  test('focus returns to the input after opening and switching tabs', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await expectMessageInputFocused(page)

    await app.openNewTab()
    await expectMessageInputFocused(page)

    await app.openNewTab()
    await expectMessageInputFocused(page)

    await app.switchToTab(0)
    await expectMessageInputFocused(page)
  })
})
