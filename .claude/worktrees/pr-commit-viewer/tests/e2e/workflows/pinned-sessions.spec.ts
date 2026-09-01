import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'

// The pinned sidebar section only exists in editor mode (SessionSidebar is
// exclusive to EditorLayout), so every test drives the editor shell.
test.describe('Pinned sessions', () => {
  test('star action in the orb pins the active session into the sidebar', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // A live session (with an agentSessionId) is required for the pin action.
    await conversation.typeAndSend('Pin this session please')
    await conversation.waitForResponse()
    await app.switchToEditorMode()

    const pinBtn = page.locator(`${ACTIVE_SHELL} [data-orb-action="pin"]`).first()
    await expect(pinBtn).toBeVisible()

    // When: the user clicks the star
    await pinBtn.click()

    // Then: a skinny pinned row appears in the sidebar showing the title
    const pinnedItem = page.locator(`${ACTIVE_SHELL} .pinned-item`).first()
    await expect(pinnedItem).toBeVisible({ timeout: 3000 })
    await expect(pinnedItem).toContainText('Pin this session please')

    // And: the orb action reflects the pinned state
    await expect(pinBtn).toContainText('Pinned')

    // Clean up so the shared ~/.solus manifest isn't polluted across runs.
    await page.keyboard.press('Alt+Shift+x')
    await expect(page.locator(`${ACTIVE_SHELL} .pinned-item`)).toHaveCount(0)
  })

  test('pinning via the Alt+Shift+X hotkey toggles the pin', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Hotkey pin target')
    await conversation.waitForResponse()
    await app.switchToEditorMode()

    // Pin via hotkey
    await page.keyboard.press('Alt+Shift+x')
    const pinnedItem = page.locator(`${ACTIVE_SHELL} .pinned-item`).first()
    await expect(pinnedItem).toBeVisible({ timeout: 3000 })

    // Unpin via the same hotkey
    await page.keyboard.press('Alt+Shift+x')
    await expect(page.locator(`${ACTIVE_SHELL} .pinned-item`)).toHaveCount(0)
  })

  test('clicking a pinned row focuses the already-open session tab', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Focus me from the pin')
    await conversation.waitForResponse()
    await app.switchToEditorMode()

    await page.locator(`${ACTIVE_SHELL} [data-orb-action="pin"]`).first().click()
    const pinnedItem = page.locator(`${ACTIVE_SHELL} .pinned-item`).first()
    await expect(pinnedItem).toBeVisible({ timeout: 3000 })

    // Open a second tab so the pinned session is no longer active.
    await page.keyboard.press('ControlOrMeta+t')
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3000 })

    // Clicking the pinned row should re-focus the original tab rather than
    // resuming a duplicate — tab count stays at 2.
    await pinnedItem.click()
    await expect(pinnedItem).toHaveAttribute('data-active', 'true', { timeout: 3000 })
    expect(await app.getTabCount()).toBe(2)

    // Clean up the manifest.
    await page.keyboard.press('Alt+Shift+x')
    await expect(page.locator(`${ACTIVE_SHELL} .pinned-item`)).toHaveCount(0)
  })
})
