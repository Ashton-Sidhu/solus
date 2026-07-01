import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const INPUT_EDITOR = `${ACTIVE_SHELL} [data-testid="message-input"] .solus-md-editor`

async function setInput(page: import('@playwright/test').Page, text: string) {
  const input = page.locator(INPUT_EDITOR)
  await input.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(text)
}

test.describe('Per-tab input state', () => {
  // WHY: each tab owns its own composer state, so a draft typed in one tab must
  // not bleed into another, and switching tabs must surface that tab's own draft
  // without any manual save/restore. If switching ever showed the wrong draft (or
  // a blank editor), tab-scoped input state would be broken.
  test('each tab keeps its own draft and switching restores it', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    // The app starts tab-less (composing into the shared active input). Create two
    // real tabs up front so each can hold its own draft.
    await app.openNewTab()
    await expect(page.getByTestId('tab-item')).toHaveCount(1)
    await app.openNewTab()
    await expect(page.getByTestId('tab-item')).toHaveCount(2)

    // Draft on the first tab.
    await app.switchToTab(0)
    await expect(page.locator(INPUT_EDITOR)).toHaveText('')
    await setInput(page, 'draft for tab one')
    await expect(page.locator(INPUT_EDITOR)).toHaveText('draft for tab one')

    // Draft on the second tab — independent, no bleed-through from tab one.
    await app.switchToTab(1)
    await expect(page.locator(INPUT_EDITOR)).toHaveText('')
    await setInput(page, 'draft for tab two')
    await expect(page.locator(INPUT_EDITOR)).toHaveText('draft for tab two')

    // Switching back surfaces tab one's draft, untouched.
    await app.switchToTab(0)
    await expect(page.locator(INPUT_EDITOR)).toHaveText('draft for tab one')

    // And tab two still has its own.
    await app.switchToTab(1)
    await expect(page.locator(INPUT_EDITOR)).toHaveText('draft for tab two')
  })

  test('switching restores identical drafts in different tabs', async ({ page }) => {
    // WHY: identical draft strings still require real editor sync on tab
    // switch; the editor instance may currently be showing another tab's doc.
    const app = new AppPage(page)
    await app.waitForAppReady()

    await app.openNewTab()
    await expect(page.getByTestId('tab-item')).toHaveCount(1)
    await app.openNewTab()
    await expect(page.getByTestId('tab-item')).toHaveCount(2)

    await app.switchToTab(0)
    await setInput(page, 'same draft')
    await expect(page.locator(INPUT_EDITOR)).toHaveText('same draft')

    await app.switchToTab(1)
    await setInput(page, 'same draft')
    await expect(page.locator(INPUT_EDITOR)).toHaveText('same draft')

    await app.switchToTab(0)
    await expect(page.locator(INPUT_EDITOR)).toHaveText('same draft')

    await app.switchToTab(1)
    await expect(page.locator(INPUT_EDITOR)).toHaveText('same draft')
  })
})
