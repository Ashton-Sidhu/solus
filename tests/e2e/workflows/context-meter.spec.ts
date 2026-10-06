import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.workspace-shell'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`
const METER = `${ACTIVE_TAB} [data-testid="context-meter-trigger"]`

/** The meter is a task-mode control: it shows only in a conversation the
 *  sidebar files under a task row. A loose session gives ⌘T a project; ⌘T
 *  files a task there and opens its lead draft with the task page beside it. */
async function sendAsTaskLead(page: Page, conversation: ConversationPage, prompt: string) {
  await conversation.typeAndSend('A loose session in the project')
  await conversation.waitForResponse()
  await page.keyboard.press('ControlOrMeta+t')
  await expect(page.getByRole('dialog', { name: 'Task' })).toBeVisible({ timeout: 5000 })
  await conversation.typeAndSend(prompt)
  await conversation.waitForResponse()
}

// The mock backend reports input 50K + cache-read 10K = 60K occupancy against a
// 200K window (30% used) for prompts containing __MOCK_USAGE__. Output (1.2K) is
// reported too, as run spend — it must NOT count toward occupancy.
test.describe('Context usage meter', () => {
  test('a loose session shows no meter', async ({ page }) => {
    // WHY: the meter belongs to task mode; a session with no task keeps its
    // input bar free of it.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Report tokens __MOCK_USAGE__')
    await conversation.waitForResponse()

    await expect(page.locator(METER)).toHaveCount(0)
  })

  test('a task lead says usage is not reported before any arrives', async ({ page }) => {
    // The ring is the bare track until a turn reports usage; its label says so
    // rather than claiming 0% was measured.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await sendAsTaskLead(page, conversation, 'A lead prompt without usage')

    const meter = page.locator(METER)
    await expect(meter).toBeVisible({ timeout: 5000 })
    await expect(meter).toHaveAccessibleName('Context usage not reported yet')
  })

  test('a task lead reports how much context is used once usage arrives', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await sendAsTaskLead(page, conversation, 'Report tokens __MOCK_USAGE__')

    // 60K occupancy of 200K is 30%. Were the 1.2K of output counted as
    // occupancy the figure would rise, so this pins output out of the window.
    await expect(page.locator(METER)).toHaveAccessibleName('30% of context used', { timeout: 5000 })
  })

  test('clicking the meter opens a detail popover with the token breakdown', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await sendAsTaskLead(page, conversation, 'Open details __MOCK_USAGE__')

    await page.locator(METER).click()

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
