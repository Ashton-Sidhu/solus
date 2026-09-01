import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

// Tab item in the tab strip. After a message is sent a tab is created.
const TAB_ITEM = '[data-testid="tab-item"]'

test.describe('Session status transitions', () => {
  test('tab transitions to running then completed after sending a message', async ({ page }) => {
    // Given: app is open
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user sends a message
    await conversation.typeAndSend('Hello')

    // Then: a tab appears (tab is created on first send)
    await page.waitForSelector(TAB_ITEM, { timeout: 5000 })

    // And: eventually the tab shows completed status once the response is done
    await conversation.waitForResponse()

    // The tab should show the completed status icon after the run finishes
    await expect(async () => {
      const status = await page.locator(TAB_ITEM).first().getAttribute('data-status')
      expect(status).toBe('completed')
    }).toPass({ timeout: 5000 })
  })

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
  })

  test('tab shows completed status icon after a successful response', async ({ page }) => {
    // Given: app is open and a message has been sent and responded to
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Test completion status')
    await conversation.waitForResponse()

    // Then: the tab strip shows a status icon (CheckCircle for completed)
    // We verify by checking data-status on the tab item
    const tabStatus = await page.locator(TAB_ITEM).first().getAttribute('data-status')
    expect(tabStatus).toBe('completed')

    // And: the status icon element is present with the completed status
    await expect(page.locator(`[data-testid="tab-status-icon"][data-status="completed"]`)).toBeVisible()
  })

  test('tab label reflects needs-attention when permission is required', async ({ page }) => {
    // Given: app is open
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user sends a message that triggers a permission request
    await conversation.typeAndSend('Please run __MOCK_PERMISSION__')

    // Then: the permission card appears in the conversation
    await page.waitForSelector(`${ACTIVE_TAB} [data-testid="permission-card"]`, { timeout: 8000 })
    await expect(page.locator(`${ACTIVE_TAB} [data-testid="permission-card"]`)).toBeVisible()
  })

  test('tab status becomes awaiting_input when a permission request is pending', async ({ page }) => {
    // Given: app is open
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user triggers a permission request
    await conversation.typeAndSend('Run a command __MOCK_PERMISSION__')

    // Wait for the tab to appear and then for status to be awaiting_input
    await page.waitForSelector(TAB_ITEM, { timeout: 5000 })

    await expect(async () => {
      const status = await page.locator(TAB_ITEM).first().getAttribute('data-status')
      expect(status).toBe('awaiting_input')
    }).toPass({ timeout: 8000 })
  })

  test('tab gets needs-attention class when awaiting permission', async ({ page }) => {
    // Given: app is open
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user triggers a permission request
    await conversation.typeAndSend('Run bash __MOCK_PERMISSION__')

    // Wait for the permission card
    await page.waitForSelector(`${ACTIVE_TAB} [data-testid="permission-card"]`, { timeout: 8000 })

    // Then: the tab item gets the needs-attention CSS class
    await expect(async () => {
      const tab = page.locator(`${TAB_ITEM}.needs-attention`)
      return expect(tab).toBeVisible()
    }).toPass({ timeout: 3000 })
  })

  test('tab aria-label includes needs input when awaiting permission', async ({ page }) => {
    // Given: app is open
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user triggers a permission request
    await conversation.typeAndSend('Check permission __MOCK_PERMISSION__')

    // Wait for permission card to appear
    await page.waitForSelector(`${ACTIVE_TAB} [data-testid="permission-card"]`, { timeout: 8000 })

    // Then: the tab aria-label includes the attention descriptor
    await expect(async () => {
      const label = await page.locator(TAB_ITEM).first().getAttribute('aria-label')
      expect(label).toContain('needs input')
    }).toPass({ timeout: 3000 })
  })

  test('permission card shows allow and deny buttons', async ({ page }) => {
    // Given: app is open and a permission request is pending
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user triggers a permission request
    await conversation.typeAndSend('Require permission __MOCK_PERMISSION__')

    // Wait for the permission card
    const card = page.locator(`${ACTIVE_TAB} [data-testid="permission-card"]`)
    await card.waitFor({ state: 'visible', timeout: 8000 })

    // Then: the allow and deny buttons are visible
    const allowBtn = card.locator('[data-testid="permission-option"][data-kind="allow"]')
    const denyBtn = card.locator('[data-testid="permission-option"][data-kind="deny"]')

    await expect(allowBtn).toBeVisible()
    await expect(denyBtn).toBeVisible()
    expect(await allowBtn.textContent()).toContain('Allow')
    expect(await denyBtn.textContent()).toContain('Deny')
  })

  test('permission approval and denial both resolve the pending run', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Approve this __MOCK_PERMISSION__')
    let card = page.locator(`${ACTIVE_TAB} [data-testid="permission-card"]`)
    await card.waitFor({ state: 'visible', timeout: 8000 })
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

  test('rate limit card appears when session is rate limited', async ({ page }) => {
    // Given: app is open
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user sends a message that triggers a rate limit
    await conversation.typeAndSend('Please process __MOCK_RATE_LIMIT__')

    // Then: the rate limit card appears
    await page.waitForSelector(`${ACTIVE_TAB} [data-testid="rate-limit-card"]`, { timeout: 8000 })
    await expect(page.locator(`${ACTIVE_TAB} [data-testid="rate-limit-card"]`)).toBeVisible()
  })

  test('tab status becomes rate_limited when rate limited', async ({ page }) => {
    // Given: app is open
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // When: user triggers a rate limit
    await conversation.typeAndSend('Trigger rate limit __MOCK_RATE_LIMIT__')

    // Then: the tab status becomes rate_limited
    await page.waitForSelector(TAB_ITEM, { timeout: 5000 })
    await expect(async () => {
      const status = await page.locator(TAB_ITEM).first().getAttribute('data-status')
      expect(status).toBe('rate_limited')
    }).toPass({ timeout: 8000 })
  })

  test('rate limit card shows queue and send now buttons', async ({ page }) => {
    // Given: app is open and a rate limit is triggered
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Rate limit test __MOCK_RATE_LIMIT__')

    // Wait for the rate limit card
    const card = page.locator(`${ACTIVE_TAB} [data-testid="rate-limit-card"]`)
    await card.waitFor({ state: 'visible', timeout: 8000 })

    // Then: queue, send now, and stop buttons are visible
    await expect(card.getByText('Queue it')).toBeVisible()
    await expect(card.getByText('Send now')).toBeVisible()
    await expect(card.getByText('Stop')).toBeVisible()
  })

  test('rate limited session recovers when the user sends queued work now', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Trigger recovery __MOCK_RATE_LIMIT__')
    const card = page.locator(`${ACTIVE_TAB} [data-testid="rate-limit-card"]`)
    await card.waitFor({ state: 'visible', timeout: 8000 })

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
    // Given: two tabs are open and both have completed conversations
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

    await conversation.typeAndSend('Second tab message')
    await conversation.waitForResponse()

    // Then: both tabs independently show completed status
    await expect(async () => {
      const statuses = await page.locator(TAB_ITEM).evaluateAll(
        (tabs) => tabs.map((t) => t.getAttribute('data-status')),
      )
      expect(statuses.every((s) => s === 'completed')).toBe(true)
    }).toPass({ timeout: 5000 })
  })
})
