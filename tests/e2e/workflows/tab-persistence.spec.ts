import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const TAB_ITEM = '[data-testid="tab-item"]'
const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`
const INPUT_EDITOR = `${ACTIVE_SHELL} [data-testid="message-input"] .solus-md-editor`
// Both the editor and pill shells stay mounted (one hidden), so each renders its
// own TabStrip. Scope tab lookups to the visible shell to count logical tabs.
const VISIBLE_TAB_ITEM = `${ACTIVE_SHELL} ${TAB_ITEM}`

async function setInput(page: import('@playwright/test').Page, text: string) {
  const input = page.locator(INPUT_EDITOR)
  await input.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(text)
}

test.describe('Tab persistence across reload', () => {
  test('open tabs reappear after page reload', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('First tab message')
    await page.waitForSelector(TAB_ITEM, { timeout: 5000 })
    await conversation.waitForResponse()

    await app.openNewTab()
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3000 })
    await app.switchToTab(1)
    await conversation.typeAndSend('Second tab message')
    await conversation.waitForResponse()

    const tabCountBefore = await app.getTabCount()
    expect(tabCountBefore).toBe(2)

    await page.reload()
    await app.waitForAppReady()

    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 10_000 })
  })

  test('active tab is restored after reload', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Tab one')
    await page.waitForSelector(TAB_ITEM, { timeout: 5000 })
    await conversation.waitForResponse()

    await app.openNewTab()
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3000 })
    await app.switchToTab(1)
    await conversation.typeAndSend('Tab two')
    await conversation.waitForResponse()

    // Second tab (index 1) should be active
    const activeBeforeReload = await page.locator(`${TAB_ITEM}[aria-selected="true"]`).textContent()

    await page.reload()
    await app.waitForAppReady()

    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 10_000 })

    const activeAfterReload = await page.locator(`${TAB_ITEM}[aria-selected="true"]`).textContent()
    expect(activeAfterReload).toBe(activeBeforeReload)
  })

  test('draft input text is restored per tab after reload', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await app.openNewTab()
    await app.openNewTab()
    await expect(page.locator(VISIBLE_TAB_ITEM)).toHaveCount(2)

    await app.switchToTab(0)
    await setInput(page, 'draft before refresh one')
    await app.switchToTab(1)
    await setInput(page, 'draft before refresh two')

    await page.reload()
    await app.waitForAppReady()

    await expect(page.locator(VISIBLE_TAB_ITEM)).toHaveCount(2)
    await app.switchToTab(0)
    await expect(page.locator(INPUT_EDITOR)).toHaveText('draft before refresh one')
    await app.switchToTab(1)
    await expect(page.locator(INPUT_EDITOR)).toHaveText('draft before refresh two')
  })

  // Regression: a session still running (paused on a permission request) at reload
  // time must reattach to the live backend session and recover its non-idle status —
  // not appear as a finished/idle session. The status is restored via
  // bindRuntimeSession's return value, so the backend session must carry its
  // sessionContext across session_init for the bind to succeed.
  test('running session reattaches as non-idle after reload', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // __MOCK_PERMISSION__ leaves the session alive and paused (awaiting_input) —
    // the run never completes, so the session stays running across the reload.
    await conversation.typeAndSend('Run a command __MOCK_PERMISSION__')
    await page.waitForSelector(`${ACTIVE_TAB} [data-testid="permission-card"]`, { timeout: 8000 })

    // Sanity: the live session is non-idle before the reload.
    await expect(page.locator(VISIBLE_TAB_ITEM).first()).toHaveAttribute('data-status', 'awaiting_input')

    await page.reload()
    await app.waitForAppReady()

    // After reload the tab must reattach to the running backend session and
    // restore its live status via bindRuntimeSession, not fall back to idle.
    await expect(page.locator(VISIBLE_TAB_ITEM).first()).toHaveAttribute('data-status', 'awaiting_input', {
      timeout: 10_000,
    })
  })

  // Regression: a rate-limited session moves the blocked run into the server
  // queue, so the backend process is no longer "running". Rebind must still
  // restore the rate-limited status and queued UI; otherwise the refreshed
  // client appears idle and the next user message creates a confusing double
  // queue instead of showing the existing blocked work.
  test('rate-limited session reattaches with queued state after reload', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Trigger rate limit before reload __MOCK_RATE_LIMIT__')
    await page.waitForSelector(`${ACTIVE_TAB} [data-testid="rate-limit-card"]`, { timeout: 8000 })
    await expect(page.locator(VISIBLE_TAB_ITEM).first()).toHaveAttribute('data-status', 'rate_limited')

    await page.reload()
    await app.waitForAppReady()

    await expect(page.locator(VISIBLE_TAB_ITEM).first()).toHaveAttribute('data-status', 'rate_limited', {
      timeout: 10_000,
    })
    await expect(page.locator(`${ACTIVE_TAB} [data-testid="rate-limit-card"]`)).toBeVisible()
  })
})
