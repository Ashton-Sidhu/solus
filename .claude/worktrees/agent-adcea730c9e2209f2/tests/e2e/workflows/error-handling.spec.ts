import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

test.describe('Error handling workflow', () => {
  test('app recovers gracefully when input is cleared after send', async ({ page }) => {
    // Given: a message is sent and a response received
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Test message')
    await conversation.waitForResponse()

    // Then: the input is empty and ready for the next message
    const inputText = await page.locator(`${ACTIVE_SHELL} [data-testid="message-input"] .solus-md-editor`).innerText()
    expect(inputText.trim()).toBe('')
  })

  test('empty message does not submit', async ({ page }) => {
    // Given: input is empty
    const app = new AppPage(page)
    await app.waitForAppReady()

    // When: user presses Enter with no text
    await page.locator(`${ACTIVE_SHELL} [data-testid="message-input"]`).click()
    await page.keyboard.press('Enter')

    // Then: no assistant message appears (nothing to submit). toHaveCount auto-retries.
    await expect(page.locator(`${ACTIVE_TAB} [data-testid="assistant-message"]`)).toHaveCount(0)
  })
})
