import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

/**
 * Phase 4 — diagrams get the same unified work-shell header as documents:
 * Chat menu, Open-in-split / Focus, and Copy. These mirror the document tests
 * to prove the shared WorkHeaderActions contract works for both work types.
 */
test.describe('Diagram chat workflow', () => {
  test('diagram header exposes the shared Chat menu', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    await conversation.typeAndSend('__MOCK_DIAGRAM__ sketch the system')
    const card = page.locator(`${ACTIVE_TAB} [data-testid="diagram-card"]`)
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    await card.click()

    // The diagram shell renders inline in the pane with the shared header.
    const chatBtn = page.locator(`${ACTIVE_SHELL} [data-testid="open-chat"]`)
    await expect(chatBtn).toBeVisible({ timeout: 5_000 })
    await chatBtn.click()

    const chatMenu = page.locator('.work-chat-menu')
    await expect(chatMenu).toBeVisible()
    await expect(chatMenu.locator('button')).toHaveCount(2)
  })

  test('opening a new chat from a diagram binds the session and splits the layout', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    await conversation.typeAndSend('__MOCK_DIAGRAM__ sketch the system')
    const card = page.locator(`${ACTIVE_TAB} [data-testid="diagram-card"]`)
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    await card.click()

    await page.locator(`${ACTIVE_SHELL} [data-testid="open-chat"]`).click()
    const chatMenu = page.locator('.work-chat-menu')
    await expect(chatMenu).toBeVisible()
    await chatMenu.locator('button').nth(1).click() // New chat

    // Session is bound to the diagram (chip shows). Scoped to the active mode
    // shell — the hidden mode keeps its own copy of the chip mounted.
    const chip = page.locator(`${ACTIVE_SHELL} [data-testid="bound-work-chip"]`)
    await expect(chip).toBeVisible({ timeout: 5_000 })
    await expect(chip).toContainText('Mock Architecture')
  })
})
