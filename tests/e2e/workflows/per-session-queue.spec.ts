import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`
const QUEUED_BUBBLE = `${ACTIVE_TAB} .user-bubble-queued`

test.describe('Per-session prompt queue', () => {
  test('second prompt queues when session is awaiting permission', async ({ page }) => {
    // Given: app open and a permission request leaves the session in awaiting_input (a busy state).
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Run a command __MOCK_PERMISSION__')
    await page.waitForSelector(`${ACTIVE_TAB} [data-testid="permission-card"]`, { timeout: 8000 })

    // When: user sends a second prompt while the session is still busy.
    await conversation.typeAndSend('queued follow-up')

    // Then: the second prompt renders as a queued bubble (control plane enqueued it).
    await expect(page.locator(QUEUED_BUBBLE)).toContainText('queued follow-up', { timeout: 3000 })
  })

  test('a third prompt also queues behind the first two', async ({ page }) => {
    // Given: a busy session with one queued prompt already.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Run __MOCK_PERMISSION__')
    await page.waitForSelector(`${ACTIVE_TAB} [data-testid="permission-card"]`, { timeout: 8000 })

    await conversation.typeAndSend('first queued')
    await expect(page.locator(QUEUED_BUBBLE).filter({ hasText: 'first queued' })).toBeVisible({ timeout: 3000 })

    // When: a third prompt is submitted.
    await conversation.typeAndSend('second queued')

    // Then: both queued prompts appear (FIFO under the same session).
    await expect(page.locator(QUEUED_BUBBLE)).toHaveCount(2, { timeout: 3000 })
    await expect(page.locator(QUEUED_BUBBLE).nth(0)).toContainText('first queued')
    await expect(page.locator(QUEUED_BUBBLE).nth(1)).toContainText('second queued')
  })

  test('a fresh tab with an idle session dispatches immediately (no queue)', async ({ page }) => {
    // Given: a fresh app — no active session.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user sends a prompt.
    await conversation.typeAndSend('hello')

    // Then: no queued bubble appears — the prompt runs immediately and the
    // session completes through the normal path.
    await conversation.waitForResponse()
    await expect(page.locator(QUEUED_BUBBLE)).toHaveCount(0)
  })
})
