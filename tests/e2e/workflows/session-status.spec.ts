import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

// Tab item in the tab strip. After a message is sent a tab is created.
const TAB_ITEM = '[data-testid="tab-item"]'

test.describe('Session status transitions', () => {
  test('tab status icon spins while running and stops after completion', async ({ page }) => {
    // Given: app is open
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user sends a message — poll immediately for the running spinner
    await conversation.typeAndSend('Hello again')

    // The running status should appear shortly after send
    await page.waitForSelector(TAB_ITEM, { timeout: 5000 })
    await expect(async () => {
      const statusEl = page.locator(`${TAB_ITEM} .tab-status-spin`)
      return expect(statusEl).toBeVisible()
    }).toPass({ timeout: 5000 })

    // After response completes the spinner should be gone
    await conversation.waitForResponse()
    await expect(page.locator(`${TAB_ITEM} .tab-status-spin`)).toBeHidden()
    await expect(page.locator(TAB_ITEM).first()).toHaveAttribute('data-status', 'completed')
    await expect(page.locator('[data-testid="tab-status-icon"][data-status="completed"]')).toBeVisible()
  })

  test('permission approval and denial both resolve the pending run', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Approve this __MOCK_PERMISSION__')
    let card = page.locator(`${ACTIVE_TAB} [data-testid="permission-card"]`)
    await card.waitFor({ state: 'visible', timeout: 8000 })
    await expect(page.locator(TAB_ITEM).first()).toHaveAttribute('data-status', 'awaiting_input')
    await expect(page.locator(TAB_ITEM).first()).toHaveAttribute('aria-label', /needs input/)
    await card.locator('[data-testid="permission-option"][data-kind="allow"]').click()

    await expect(card).not.toBeVisible({ timeout: 5000 })
    await expect(page.locator(`${ACTIVE_TAB} [data-testid="assistant-message"]`).last()).toContainText('Permission approved', { timeout: 8000 })
    await expect(async () => {
      expect(await page.locator(TAB_ITEM).first().getAttribute('data-status')).toBe('completed')
    }).toPass({ timeout: 5000 })

    await app.openNewTab()
    await app.switchToTab(1)

    await conversation.typeAndSend('Deny this __MOCK_PERMISSION__')
    card = page.locator(`${ACTIVE_TAB} [data-testid="permission-card"]`)
    await card.waitFor({ state: 'visible', timeout: 8000 })
    await card.locator('[data-testid="permission-option"][data-kind="deny"]').click()

    await expect(card).not.toBeVisible({ timeout: 5000 })
    await expect(page.locator(`${ACTIVE_TAB} [data-testid="assistant-message"]`).last()).toContainText('Permission denied', { timeout: 8000 })
    await expect(async () => {
      expect(await page.locator(TAB_ITEM).nth(1).getAttribute('data-status')).toBe('completed')
    }).toPass({ timeout: 5000 })
  })

  test('rate limited session recovers when the user sends queued work now', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Trigger recovery __MOCK_RATE_LIMIT__')
    const card = page.locator(`${ACTIVE_TAB} [data-testid="rate-limit-card"]`)
    await card.waitFor({ state: 'visible', timeout: 8000 })

    await expect(page.locator(TAB_ITEM).first()).toHaveAttribute('data-status', 'rate_limited')
    await expect(card.getByText('Queue until reset')).toBeVisible()
    await expect(card.getByText('Stop & discard')).toBeVisible()

    await conversation.typeAndSend('recover after rate limit')
    await expect(page.locator(`${ACTIVE_TAB} .user-bubble-queued`)).toContainText('recover after rate limit', { timeout: 3000 })

    await card.getByText('Send now').click()

    await expect(page.locator(`${ACTIVE_TAB} .user-bubble-queued`)).toHaveCount(0, { timeout: 5000 })
    await expect(page.locator(`${ACTIVE_TAB} [data-testid="user-message"]`).last()).toContainText('recover after rate limit', { timeout: 5000 })
    await conversation.waitForResponse()
    await expect(async () => {
      expect(await page.locator(TAB_ITEM).first().getAttribute('data-status')).toBe('completed')
    }).toPass({ timeout: 8000 })
  })

  test('grouping by status replaces per-tab icons with a binder divider', async ({ page }) => {
    // WHY: grouped mode marks each status section with a single binder divider
    // that carries the status glyph. The per-tab status icon would then be
    // redundant, so it must disappear in this mode — the status is shown once on
    // the divider, not again on every tab. If the per-tab icon reappears while
    // grouped, the dedup that justifies the divider is broken; if no divider
    // renders, the section is unlabelled. Scoped to the active shell so the
    // hidden mirror shell never satisfies the assertions.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Group me by status')
    await conversation.waitForResponse()

    const statusIcon = page.locator(`${ACTIVE_SHELL} [data-testid="tab-status-icon"]`)
    const binder = page.locator(`${ACTIVE_SHELL} .tab-group-binder`)
    const groupToggle = page.locator(`${ACTIVE_SHELL} [data-testid="tab-group-toggle"]`)

    // Flat mode: the tab carries its own status icon and there is no divider.
    await expect(statusIcon.first()).toBeVisible()
    await expect(binder).toHaveCount(0)

    // When: the user groups tabs by status
    await groupToggle.click()

    // Then: a binder divider leads the section (carrying the status glyph) and
    // the now-redundant per-tab icon is gone.
    await expect(binder.first()).toBeVisible()
    await expect(binder.first().locator('svg')).toBeVisible()
    await expect(statusIcon).toHaveCount(0)

    // And: ungrouping restores the per-tab icon and removes the divider.
    await groupToggle.click()
    await expect(binder).toHaveCount(0)
    await expect(statusIcon.first()).toBeVisible()
  })

  test('multiple tabs each carry independent session status', async ({ page }) => {
    // A completed tab must keep its status when another tab needs permission.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // Tab 1: send a message and wait for completion
    await conversation.typeAndSend('First tab message')
    await conversation.waitForResponse()
    await expect(async () => {
      expect(await page.locator(TAB_ITEM).first().getAttribute('data-status')).toBe('completed')
    }).toPass({ timeout: 5000 })

    // Open a second tab and send another message
    await app.openNewTab()
    await expect(async () => {
      expect(await page.locator(TAB_ITEM).count()).toBe(2)
    }).toPass({ timeout: 3000 })
    await app.switchToTab(1)

    await conversation.typeAndSend('Second tab __MOCK_PERMISSION__')

    await expect(page.locator(TAB_ITEM).nth(1)).toHaveAttribute('data-status', 'awaiting_input', { timeout: 8000 })
    await expect(page.locator(TAB_ITEM).first()).toHaveAttribute('data-status', 'completed')
  })
})
