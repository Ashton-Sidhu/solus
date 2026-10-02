import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.workspace-shell'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

/**
 * Diagrams carry the same docked composer as every work page: one glyph at
 * rest, and Send pops a session bound to the diagram out beside it.
 */
test.describe('Diagram chat workflow', () => {
  test('starting a session from a diagram binds it and splits the layout', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await app.waitForWorkspace()

    await conversation.typeAndSend('__MOCK_DIAGRAM__ sketch the system')
    const card = page.locator(`${ACTIVE_TAB} [data-testid="diagram-card"]`)
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    await card.click()

    const glyph = page.locator(`${ACTIVE_SHELL} [data-testid="open-page-composer"]`)
    await expect(glyph).toBeVisible({ timeout: 5_000 })
    await glyph.click()
    const input = page.getByTestId('page-composer').getByTestId('message-input')
    await input.pressSequentially('add the cache tier')
    await page.keyboard.press('Enter')

    // Session is bound to the diagram (chip shows). Scoped to the active mode
    // shell — the hidden mode keeps its own copy of the chip mounted.
    const chip = page.locator(`${ACTIVE_SHELL} [data-testid="bound-work-chip"]`)
    await expect(chip).toBeVisible({ timeout: 5_000 })
    await expect(chip).toContainText('Mock Architecture')
  })
})
