import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

// The mock backend reports input 50K + cache-read 10K = 60K occupancy against a
// 200K window (30% used) for prompts containing __MOCK_USAGE__. Output (1.2K) is
// reported too, as run spend — it must NOT count toward occupancy.
test.describe('Context usage meter', () => {
  test('meter reads zero before a response', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    // Always a figure, never a placeholder — the meter starts at 0% and fills
    // in. The popover footnote is where "not reported yet" is said.
    const label = page.locator(`${ACTIVE_TAB} [data-testid="context-meter-label"]`)
    await expect(label).toBeVisible()
    await expect(label).toHaveText('0%')
  })

  test('meter reports how much context is used once usage arrives', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Report tokens __MOCK_USAGE__')
    await conversation.waitForResponse()

    const label = page.locator(`${ACTIVE_TAB} [data-testid="context-meter-label"]`)
    await expect(label).toBeVisible({ timeout: 5000 })
    // 60K occupancy of 200K is 30%. Were the 1.2K of output counted as
    // occupancy the figure would rise, so this pins output out of the window.
    await expect(label).toHaveText('30%')
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
    await expect(popover).toContainText('50,000') // input — in the window
    await expect(popover).toContainText('10,000') // cache read — in the window
    // Output is spend, not occupancy, so it appears under its own heading.
    await expect(popover).toContainText('This run')
    await expect(popover).toContainText('1,200')

    // Escape closes it.
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
  })
})
