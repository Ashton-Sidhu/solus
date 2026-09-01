import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'
import { PlanPage } from '../helpers/plan.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

/**
 * The document/plan viewer is global, not per-tab: opening a work or plan shows
 * it irrespective of which tab is active. These tests encode that WHY — they
 * would fail under the old per-tab `tab.activeWorkId`/`tab.activePlanId` model,
 * where switching to a tab that never opened the artifact dropped the modal.
 */
test.describe('Artifact viewer is decoupled from the active tab', () => {
  test('a document opened in one tab stays open after switching tabs', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // Open a document from tab 1's conversation.
    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })
    await documentCard.click()

    const modal = page.getByTestId('document-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // A brand-new tab (different session) becomes active — the document must persist.
    await app.openNewTab()
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3_000 })
    await expect(modal).toBeVisible()

    // Switching back to the originating tab keeps it open too.
    await app.switchToTab(0)
    await expect(modal).toBeVisible()

    // Closing clears it for good, regardless of which tab is active.
    await page.getByTestId('document-modal-close').click()
    await expect(modal).toBeHidden({ timeout: 3_000 })
  })

  test('a plan opened in one tab stays open after switching tabs', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const planPage = new PlanPage(page)
    await app.waitForAppReady()

    // Enter plan mode, then explicitly open the finished plan from its card.
    await page.keyboard.press('Alt+Shift+Tab')
    await expect(page.locator(`${ACTIVE_SHELL} button`).filter({ hasText: 'Plan' }).first()).toBeVisible()
    await conversation.typeAndSend('__MOCK_PLAN__ create a migration plan')
    await planPage.openFromCard()

    const modal = page.getByTestId('plan-modal')
    await expect(modal).toBeVisible()

    // New tab becomes active — the plan stays on screen (global viewer).
    await app.openNewTab()
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3_000 })
    await expect(modal).toBeVisible()

    await app.switchToTab(0)
    await expect(modal).toBeVisible()
  })
})
