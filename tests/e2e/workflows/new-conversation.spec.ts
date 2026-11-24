import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

test.describe('New conversation workflow', () => {
  test('user can send multiple messages in sequence', async ({ page }) => {
    // Given: app is open
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user sends two messages
    await conversation.typeAndSend('First message')
    await conversation.waitForResponse()
    await expect(page.locator('.workspace-shell [data-testid="message-input"] .cm-content')).toHaveText('')

    await conversation.typeAndSend('Second message')

    await expect.poll(() => conversation.getAllAssistantMessages()).toHaveLength(2)
  })

  test('send button triggers message submission', async ({ page }) => {
    // Given: app is open
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user types then clicks send button
    await conversation.typeMessage('Click send test')
    await conversation.clickSendButton()

    // Then: a response appears
    await conversation.waitForResponse()
    await expect(page.locator('.workspace-shell .tab-slot:not(.tab-hidden) [data-testid="assistant-message"]').first()).toBeVisible()
  })

  test('plain URL text remains separate from following typed text', async ({ page }) => {
    // WHY: source-first editing has no inherited link mark; the exact prompt
    // must survive typing and render as a link only after it is sent.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const activeShell = page.locator('.workspace-shell')
    const linkText = 'https://example.com'
    const trailingText = ' after'

    await app.waitForAppReady()

    await conversation.typeMessage(`${linkText}${trailingText}`)

    const editor = activeShell.locator('[data-testid="message-input"] .cm-content')
    await expect(editor).toHaveText(`${linkText}${trailingText}`)

    await conversation.sendMessage()

    const userMessageLink = page
      .locator('.workspace-shell .tab-slot:not(.tab-hidden) [data-testid="user-message"] a')
      .first()
    await expect(userMessageLink).toHaveText(linkText)
    await expect(page.locator('[data-testid="user-message"]').first()).toContainText(`${linkText}${trailingText}`)
  })
})
