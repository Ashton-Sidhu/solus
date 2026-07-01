import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

// The mock backend reports input 50K + cache-read 10K = 60K occupancy against a
// 200K window (30%) for prompts containing __MOCK_USAGE__. Output (1.2K) is
// reported too but must NOT count toward occupancy — it isn't in the window yet.
test.describe('Context usage meter', () => {
  test('meter is hidden until a response reports usage', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    // Before any usage is reported, the meter shows nothing (no 0%/0-token chip).
    await expect(page.locator(`${ACTIVE_TAB} [data-testid="context-meter"]`)).toHaveCount(0)
  })

  test('meter shows used / total context after a response reports usage', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Report tokens __MOCK_USAGE__')
    await conversation.waitForResponse()

    const label = page.locator(`${ACTIVE_TAB} [data-testid="context-meter-label"]`)
    await expect(label).toBeVisible({ timeout: 5000 })
    // 60K occupancy (input + cache read), not 61.2K — output is excluded.
    await expect(label).toHaveText('60K / 200K')
  })

  test('clicking the meter opens a detail popover with the token breakdown', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Open details __MOCK_USAGE__')
    await conversation.waitForResponse()

    await page.locator(`${ACTIVE_TAB} [data-testid="context-meter-trigger"]`).click()

    const popover = page.locator(`${ACTIVE_TAB} [data-testid="context-meter-popover"]`)
    await expect(popover).toBeVisible()
    await expect(popover).toContainText('30%')
    await expect(popover).toContainText('50,000') // input
    await expect(popover).toContainText('10,000') // cache read
    await expect(popover).toContainText('1,200') // output

    // Escape closes it.
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
  })
})
