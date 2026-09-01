import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

// Prompt keyword that triggers the mock backend's markdown response.
// Avoids markdown-special chars: the input editor escapes them on serialize,
// which would stop the typed prompt from matching the mock's trigger key.
const MARKDOWN_PROMPT = 'MOCKMARKDOWN'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
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

    const msgLocator = page.locator(`${ACTIVE_TAB} [data-testid="assistant-message"]`).last()

    // A <strong> element must exist — bold text was rendered, not left as **…**.
    await expect(msgLocator.locator('strong').first()).toBeVisible()

    // Raw markdown syntax must NOT appear in the text content.
    const rawText = await msgLocator.textContent() ?? ''
    expect(rawText).not.toContain('**')
    expect(rawText).not.toContain('##')
  })

  test('no orphan streaming node and no duplication after task_complete', async ({ page }) => {
    // WHY: streamed and committed render paths must converge to a single message node.
    // Fails if the streaming block is left behind after commit, or if the text appears twice.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend(MARKDOWN_PROMPT)
    await conversation.waitForResponse()

    // Exactly one assistant-message block.
    const msgCount = await page.locator(`${ACTIVE_TAB} [data-testid="assistant-message"]`).count()
    expect(msgCount).toBe(1)

    // The committed message contains the rendered bold text.
    const msgLocator = page.locator(`${ACTIVE_TAB} [data-testid="assistant-message"]`).first()
    await expect(msgLocator.locator('strong').first()).toBeVisible()
  })
})
