import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.workspace-shell'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`
const QUEUED_BUBBLE = `${ACTIVE_TAB} .user-bubble-queued`

test.describe('Per-session prompt queue', () => {
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
})
