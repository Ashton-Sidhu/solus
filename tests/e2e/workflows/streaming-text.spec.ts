import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

// Prompt keyword that triggers the mock backend's markdown response.
// Avoids markdown-special chars: the input editor escapes them on serialize,
// which would stop the typed prompt from matching the mock's trigger key.
const MARKDOWN_PROMPT = 'MOCKMARKDOWN'

const ACTIVE_SHELL = '.workspace-shell'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

test.describe('Streaming text rendering', () => {
  test('streamed text renders as markdown (not raw syntax) after commit', async ({ page }) => {
    // WHY: after a turn commits, the text must be rendered through the markdown path —
    // no literal **…** / ## chars should appear. Fails if the plain-text path regresses.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // Trigger the markdown-bearing mock response.
    await conversation.typeAndSend(MARKDOWN_PROMPT)
    await conversation.waitForResponse()

    const messages = page.locator(`${ACTIVE_TAB} [data-testid="assistant-message"]`)

    // A <strong> element must exist — bold text was rendered, not left as **…**.
    await expect(messages.last().locator('strong').first()).toBeVisible()
    await expect(messages).toHaveCount(1)

    // Raw markdown syntax must NOT appear in the text content.
    const rawText = await messages.first().textContent() ?? ''
    expect(rawText).not.toContain('**')
    expect(rawText).not.toContain('##')
  })
})
