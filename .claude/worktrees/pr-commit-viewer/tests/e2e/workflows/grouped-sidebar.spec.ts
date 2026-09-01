import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'

// The grouped sidebar view lives in SessionSidebar, which is exclusive to
// editor mode. The grouped view replaced the old three-level indented tree
// (project ▸ branch ▸ session) with a flush "project › branch" breadcrumb so
// session titles reclaim the horizontal space the indentation used to eat.
test.describe('Grouped sidebar — breadcrumb hierarchy', () => {
  // Alt+Shift+U cycles default → status → grouped. Press until the breadcrumb
  // header appears so the test doesn't depend on the starting view mode.
  async function cycleToGrouped(page: Page) {
    const crumb = page.locator(`${ACTIVE_SHELL} .crumb-header`).first()
    for (let i = 0; i < 3; i++) {
      if (await crumb.isVisible().catch(() => false)) return
      await page.keyboard.press('Alt+Shift+u')
      await page.waitForTimeout(120)
    }
    await expect(crumb).toBeVisible({ timeout: 3000 })
  }

  test('groups sessions under a project › branch breadcrumb instead of indentation', async ({
    page,
  }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Group me under a breadcrumb')
    await conversation.waitForResponse()
    await app.switchToEditorMode()

    await cycleToGrouped(page)

    // The breadcrumb carries both the project anchor and the git branch,
    // joined by a chevron — this single line is what conveys hierarchy now.
    const crumb = page.locator(`${ACTIVE_SHELL} .crumb-header`).first()
    await expect(crumb.locator('.crumb-project')).not.toBeEmpty()
    await expect(crumb.locator('.crumb-sep')).toBeVisible()

    // Regression guard for the whole point of this change: the indentation
    // wrappers the breadcrumb replaced must not return. If these come back,
    // sessions are being nested/indented again rather than sitting flush.
    await expect(page.locator('.grouped-branches-container')).toHaveCount(0)
    await expect(page.locator('.grouped-sessions-container')).toHaveCount(0)

    // The session still renders (flush) beneath its breadcrumb.
    await expect(
      page.locator(`${ACTIVE_SHELL} .session-item.compact-item`).first(),
    ).toBeVisible()
  })

  test('clicking the breadcrumb collapses and expands its sessions', async ({
    page,
  }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Collapse me')
    await conversation.waitForResponse()
    await app.switchToEditorMode()

    await cycleToGrouped(page)

    const crumb = page.locator(`${ACTIVE_SHELL} .crumb-header`).first()
    const cards = page.locator(`${ACTIVE_SHELL} .session-item.compact-item`)
    await expect(cards.first()).toBeVisible()

    // Collapsing the breadcrumb hides the sessions grouped under it…
    await crumb.click()
    await expect(cards).toHaveCount(0)

    // …and clicking again restores them.
    await crumb.click()
    await expect(cards.first()).toBeVisible()
  })
})
