import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

test.describe('Fork session feature', () => {
  test('fork option appears in tab context menu after a session starts', async ({ page }) => {
    // Given: an active session with messages
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await conversation.typeAndSend('Hello')
    await conversation.waitForResponse()

    // When: user right-clicks the active tab
    const activeTab = page.locator('[data-testid="tab-item"][aria-selected="true"]')
    await activeTab.click({ button: 'right' })

    // Then: the Fork Session option appears in the context menu
    await expect(page.locator('.tab-ctx-menu')).toBeVisible()
    await expect(page.locator('.tab-ctx-menu').getByText('Fork Session')).toBeVisible()
  })

  test('context menu closes on backdrop click', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await conversation.typeAndSend('Hi')
    await conversation.waitForResponse()

    const activeTab = page.locator('[data-testid="tab-item"][aria-selected="true"]')
    await activeTab.click({ button: 'right' })
    await expect(page.locator('.tab-ctx-menu')).toBeVisible()

    // Click backdrop to dismiss
    await page.locator('.tab-ctx-backdrop').click()
    await expect(page.locator('.tab-ctx-menu')).not.toBeVisible()
  })

  test('forking creates a new tab with copied messages and fork message', async ({ page }) => {
    // Given: a session with messages
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await conversation.typeAndSend('Tell me a fact')
    await conversation.waitForResponse()

    const initialTabCount = await app.getTabCount()
    expect(initialTabCount).toBe(1)

    // When: user right-clicks and selects Fork Session
    const activeTab = page.locator('[data-testid="tab-item"][aria-selected="true"]')
    await activeTab.click({ button: 'right' })
    await page.locator('.tab-ctx-menu').getByText('Fork Session').click()

    // Then: a new tab opens
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3000 })

    // The new tab should show the fork origin as a conversation message
    const forkMessage = page.getByTestId('fork-session-message')
    await expect(forkMessage).toBeVisible({ timeout: 3000 })
  })

  test('forking via keyboard shortcut Alt+F creates a new tab', async ({ page }) => {
    // Given: a session with messages
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await conversation.typeAndSend('ping')
    await conversation.waitForResponse()

    const initialTabCount = await app.getTabCount()

    // When: user presses Alt+F
    await page.keyboard.press('Alt+F')

    // Then: a new tab is created
    await expect(async () => {
      expect(await app.getTabCount()).toBe(initialTabCount + 1)
    }).toPass({ timeout: 3000 })
  })

  test('fork tab title is prefixed with Fork:', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await conversation.typeAndSend('Some question')
    await conversation.waitForResponse()

    // Fork the session
    const activeTab = page.locator('[data-testid="tab-item"][aria-selected="true"]')
    await activeTab.click({ button: 'right' })
    await page.locator('.tab-ctx-menu').getByText('Fork Session').click()

    // The new active tab should have "Fork:" in its title or label
    await expect(async () => {
      const newActive = page.locator('[data-testid="tab-item"][aria-selected="true"]')
      const label = await newActive.textContent()
      expect(label).toContain('Fork')
    }).toPass({ timeout: 3000 })
  })

  test('fork message click navigates back to source tab', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await conversation.typeAndSend('Source message')
    await conversation.waitForResponse()

    // Fork the session
    const sourceTab = page.locator('[data-testid="tab-item"][aria-selected="true"]')
    await sourceTab.click({ button: 'right' })
    await page.locator('.tab-ctx-menu').getByText('Fork Session').click()

    // Wait for fork tab with the fork message
    const forkMessage = page.getByTestId('fork-session-message')
    await expect(forkMessage).toBeVisible({ timeout: 3000 })

    // Click the message to navigate back to source
    await forkMessage.click()

    // The source tab should now be active (fork tab is no longer selected)
    await expect(async () => {
      // The active tab should NOT have the fork message (we're back on source)
      const messageVisible = await page.getByTestId('fork-session-message').isVisible()
      expect(messageVisible).toBe(false)
    }).toPass({ timeout: 3000 })
  })
})
