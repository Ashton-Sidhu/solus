import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

test.describe('New conversation workflow', () => {
  test('app loads with an empty input ready to accept messages', async ({ page }) => {
    // Given: the app is open
    const app = new AppPage(page)

    // Then: the message input is visible and ready
    await app.waitForAppReady()
    await expect(page.locator('.mode-shell:not(.mode-hidden) [data-testid="message-input"]')).toBeVisible()
  })

  test('user sends a message and receives a streamed response', async ({ page }) => {
    // Given: app is open with a fresh tab
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user types and sends a message
    await conversation.typeAndSend('Hello, how are you?')

    // Then: a response streams in
    await conversation.waitForResponse()
    const responseText = await conversation.getLastAssistantMessage()
    expect(responseText.length).toBeGreaterThan(0)
  })

  test('user can send multiple messages in sequence', async ({ page }) => {
    // Given: app is open
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user sends two messages
    await conversation.typeAndSend('First message')
    await conversation.waitForResponse()

    await conversation.typeAndSend('Second message')
    await conversation.waitForResponse()

    // Then: both responses are visible
    const messages = await conversation.getAllAssistantMessages()
    expect(messages.length).toBeGreaterThanOrEqual(2)
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
    await expect(page.locator('.mode-shell:not(.mode-hidden) .tab-slot:not(.tab-hidden) [data-testid="assistant-message"]').first()).toBeVisible()
  })

  test('autolinks stop at the URL before following typed text', async ({ page }) => {
    // WHY: typing after an autolink should not inherit the link mark; otherwise
    // the input serializes normal prose as part of the URL markdown link.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const activeShell = page.locator('.mode-shell:not(.mode-hidden)')
    const linkText = 'https://example.com'
    const trailingText = ' after'

    await app.waitForAppReady()

    await conversation.typeMessage(`${linkText}${trailingText}`)

    const editorLink = activeShell.locator('[data-testid="message-input"] a')
    await expect(editorLink).toHaveText(linkText)

    await conversation.sendMessage()

    const userMessageLink = page
      .locator('.mode-shell:not(.mode-hidden) .tab-slot:not(.tab-hidden) [data-testid="user-message"] a')
      .first()
    await expect(userMessageLink).toHaveText(linkText)
    await expect(page.locator('[data-testid="user-message"]').first()).toContainText(`${linkText}${trailingText}`)
  })
})
