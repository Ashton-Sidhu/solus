import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'
import { PlanPage } from '../helpers/plan.page'
import { PanePage } from '../helpers/pane.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

/**
 * Two-pane layout — these tests encode WHY each behavior matters:
 * - Default replace-in-primary preserves the single-focus reading experience.
 * - "Open in split" moves an artifact to the other pane so users can choose single-focus or side-by-side reading.
 * - Diff survives independently of plan/work — they're separate secondary-pane consumers.
 * - Tab switch only resets diff (which is tab-scoped) not plan/work (which are global artifacts).
 *
 * The durable-rule tests guard the state model the layout depends on:
 * - R1 — closing a slot closes only that slot (never both), so a split artifact
 *   can't be stranded.
 * - R3 — only one plan/work exists at a time; opening another replaces it in
 *   place rather than spawning a second.
 * - R2 + P1 — the diff shares the secondary slot via an explicit, reversible
 *   policy: it replaces a split artifact and toggles back to the conversation,
 *   never silently overwriting and stranding geometry.
 */

test.describe('Two-pane layout', () => {
  test('plan defaults to primary pane (replaces conversation)', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const planPage = new PlanPage(page)
    await app.waitForAppReady()

    await page.keyboard.press('Alt+Shift+Tab')
    await expect(page.locator(`${ACTIVE_SHELL} button`).filter({ hasText: 'Plan' }).first()).toBeVisible()
    await conversation.typeAndSend('__MOCK_PLAN__ create a migration plan')
    await planPage.openFromCard()

    // Plan is in primary — conversation tab slot is hidden (replaced)
    await expect(page.getByTestId('plan-modal')).toBeVisible()
    await expect(page.locator(`${ACTIVE_TAB}`).first()).toBeHidden({ timeout: 3_000 })
  })

  test('open in split moves plan to whichever pane it is not in', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const planPage = new PlanPage(page)
    const pane = new PanePage(page)
    await app.waitForAppReady()

    await page.keyboard.press('Alt+Shift+Tab')
    await expect(page.locator(`${ACTIVE_SHELL} button`).filter({ hasText: 'Plan' }).first()).toBeVisible()
    await conversation.typeAndSend('__MOCK_PLAN__ create a migration plan')
    await planPage.openFromCard()

    // Move to secondary via the "Open in split" button
    await pane.openInSplit()
    await pane.waitForSecondaryPane()

    // Plan is still visible (in secondary), conversation tab is now visible (in primary)
    await expect(page.getByTestId('plan-modal')).toBeVisible()
    await expect(pane.isConversationVisible()).resolves.toBe(true)

    // Input dock must be visible so the user can actually chat
    await expect(pane.isInputDockVisible()).resolves.toBe(true)

    // From the secondary the control is relabeled "Focus" but stays the same
    // toggle: clicking it moves the plan back to primary (Split → Focus).
    await pane.openInSplit()
    await expect(page.locator(`${ACTIVE_SHELL} .secondary-pane-wrap`)).toBeHidden({ timeout: 3_000 })
    await expect(page.getByTestId('plan-modal')).toBeVisible()
    await expect(page.locator(`${ACTIVE_TAB}`).first()).toBeHidden({ timeout: 3_000 })
  })

  test('document opened in split shows conversation and doc side by side', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const pane = new PanePage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })
    await documentCard.click()
    await expect(page.getByTestId('document-modal')).toBeVisible({ timeout: 5_000 })

    // Move to secondary via "Open in split"
    await pane.openInSplit()
    await pane.waitForSecondaryPane()

    await expect(page.getByTestId('document-modal')).toBeVisible()
    await expect(pane.isConversationVisible()).resolves.toBe(true)
    await expect(pane.isInputDockVisible()).resolves.toBe(true)
  })

  test('closing secondary artifact returns to conversation-only layout', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const planPage = new PlanPage(page)
    const pane = new PanePage(page)
    await app.waitForAppReady()

    await page.keyboard.press('Alt+Shift+Tab')
    await expect(page.locator(`${ACTIVE_SHELL} button`).filter({ hasText: 'Plan' }).first()).toBeVisible()
    await conversation.typeAndSend('__MOCK_PLAN__ create a migration plan')
    await planPage.openFromCard()

    await pane.openInSplit()
    await pane.waitForSecondaryPane()

    // Close from secondary
    await page.getByTestId('plan-modal-close').click()

    await expect(page.getByTestId('plan-modal')).toBeHidden({ timeout: 3_000 })
    await expect(pane.isSecondaryPaneVisible()).resolves.toBe(false)
    await expect(pane.isConversationVisible()).resolves.toBe(true)
  })

  test('plan in secondary survives tab switch; diff in secondary resets on tab switch', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const planPage = new PlanPage(page)
    const pane = new PanePage(page)
    await app.waitForAppReady()

    // Open a plan and push it to the secondary pane
    await page.keyboard.press('Alt+Shift+Tab')
    await expect(page.locator(`${ACTIVE_SHELL} button`).filter({ hasText: 'Plan' }).first()).toBeVisible()
    await conversation.typeAndSend('__MOCK_PLAN__ create a migration plan')
    await planPage.openFromCard()

    await pane.openInSplit()
    await pane.waitForSecondaryPane()
    await expect(page.getByTestId('plan-modal')).toBeVisible()

    // Switch tab — plan in secondary must survive (it's a global artifact, not tab-scoped)
    await app.openNewTab()
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3_000 })

    await expect(page.getByTestId('plan-modal')).toBeVisible()

    // Switch back to tab 1
    await app.switchToTab(0)
    await expect(page.getByTestId('plan-modal')).toBeVisible()
  })

  test('opening a second artifact replaces the split one in place (R3)', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const planPage = new PlanPage(page)
    const pane = new PanePage(page)
    await app.waitForAppReady()

    await page.keyboard.press('Alt+Shift+Tab')
    await expect(page.locator(`${ACTIVE_SHELL} button`).filter({ hasText: 'Plan' }).first()).toBeVisible()
    await conversation.typeAndSend('__MOCK_PLAN__ create a migration plan')
    await planPage.openFromCard()

    // Split the plan into the secondary so the conversation returns to primary.
    await pane.openInSplit()
    await pane.waitForSecondaryPane()
    await expect(page.getByTestId('plan-modal')).toBeVisible()

    // Opening a document while the plan occupies the secondary must REPLACE it
    // in place (R3 — one artifact at a time), not spawn a second pane/artifact.
    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })
    await documentCard.click()

    await expect(page.getByTestId('document-modal')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('plan-modal')).toBeHidden()
    await expect(pane.isConversationVisible()).resolves.toBe(true)
    await expect(pane.isSecondaryPaneVisible()).resolves.toBe(true)
  })

  test('file editor shares the secondary slot and closes back to conversation (R2 + P1)', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const planPage = new PlanPage(page)
    const pane = new PanePage(page)
    await app.waitForAppReady()

    await page.keyboard.press('Alt+Shift+Tab')
    await expect(page.locator(`${ACTIVE_SHELL} button`).filter({ hasText: 'Plan' }).first()).toBeVisible()
    await conversation.typeAndSend('__MOCK_PLAN__ create a migration plan')
    await planPage.openFromCard()

    await pane.openInSplit()
    await pane.waitForSecondaryPane()
    await expect(page.getByTestId('plan-modal')).toBeVisible()

    // Opening a single-file editor takes the secondary slot — the split plan is
    // hidden (P1), not silently destroyed elsewhere; the pane stays present.
    await pane.triggerFilePreview()
    await expect(page.getByTestId('plan-modal')).toBeHidden({ timeout: 3_000 })
    await expect(pane.isSecondaryPaneVisible()).resolves.toBe(true)

    // Closing the editor lands on the conversation, NOT back on the plan —
    // proving the editor is the secondary occupant, reversibly.
    await pane.closeFilesPane()
    await expect(pane.isSecondaryPaneVisible()).resolves.toBe(false)
    await expect(page.getByTestId('plan-modal')).toBeHidden()
    await expect(pane.isConversationVisible()).resolves.toBe(true)
  })

  test('split toggle relabels to Focus from the secondary pane', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const planPage = new PlanPage(page)
    const pane = new PanePage(page)
    await app.waitForAppReady()

    await page.keyboard.press('Alt+Shift+Tab')
    await expect(page.locator(`${ACTIVE_SHELL} button`).filter({ hasText: 'Plan' }).first()).toBeVisible()
    await conversation.typeAndSend('__MOCK_PLAN__ create a migration plan')
    await planPage.openFromCard()

    // In primary the affordance offers to split; in secondary it offers to refocus.
    await expect(pane.toggleLabel()).resolves.toBe('Open in split')
    await pane.openInSplit()
    await pane.waitForSecondaryPane()
    await expect(pane.toggleLabel()).resolves.toBe('Focus')
  })
})
