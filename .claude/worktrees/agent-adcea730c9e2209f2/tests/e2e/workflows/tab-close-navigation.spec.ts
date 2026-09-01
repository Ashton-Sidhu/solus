import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

test.describe('Tab close navigation', () => {
  test('closing the active tab selects another tab rather than leaving nothing active', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    // Open two additional tabs so we have 3 total
    await app.openNewTab()
    await app.openNewTab()
    expect(await app.getTabCount()).toBe(3)

    await app.closeActiveTab()
    expect(await app.getTabCount()).toBe(2)

    // A tab must still be selected after the close
    const activeTab = page.locator('[data-testid="tab-item"][aria-selected="true"]')
    await expect(activeTab).toBeVisible()
  })

  test('closing the middle tab selects an adjacent neighbour', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await app.openNewTab()
    await app.openNewTab()
    expect(await app.getTabCount()).toBe(3)

    // Switch to the middle tab and close it
    await app.switchToTab(1)
    await app.closeActiveTab()

    expect(await app.getTabCount()).toBe(2)

    // The remaining active tab must be one of the two surviving tabs
    const activeTab = page.locator('[data-testid="tab-item"][aria-selected="true"]')
    await expect(activeTab).toBeVisible()
  })

  test('closing a non-active tab does not change the active tab', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await app.openNewTab()
    await app.openNewTab()
    expect(await app.getTabCount()).toBe(3)

    // Active tab is the last one (index 2) — close a non-active one
    await app.switchToTab(2)
    const activeTabLabel = await page
      .locator('[data-testid="tab-item"][aria-selected="true"]')
      .getAttribute('aria-label')

    // Close the first (non-active) tab
    const firstTab = page.getByTestId('tab-item').first()
    await firstTab.getByLabel('Close tab').click()

    expect(await app.getTabCount()).toBe(2)

    // The same tab should still be active
    const stillActiveLabel = await page
      .locator('[data-testid="tab-item"][aria-selected="true"]')
      .getAttribute('aria-label')
    expect(stillActiveLabel).toBe(activeTabLabel)
  })
})
