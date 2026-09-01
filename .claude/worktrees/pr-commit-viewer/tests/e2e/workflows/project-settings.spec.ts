import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

// The settings page has a permanent "Projects" tab listing projects; selecting one
// edits its config. The project panel gear deep-links into that tab with the current
// project preselected. Both view modes keep their settings page mounted (hidden via
// display:none), so locators are scoped to the visible tablist.
test.describe('Projects settings tab', () => {
  test('gear opens the Projects tab with project config shown', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    // The gear lives in the project panel; open the panel first if collapsed.
    if (await page.locator('.editor-shell .workspace-body.project-panel-collapsed').count()) {
      await page.keyboard.press('Alt+m')
    }
    const gear = page.locator('button[aria-label="Project settings"]:visible').first()
    await expect(gear).toBeVisible()

    await gear.click()

    const projectsTab = page.locator('[role="tablist"]:visible [role="tab"]', { hasText: 'Projects' })
    await expect(projectsTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(':visible', { hasText: /^Run commands$/ }).first()).toBeVisible()
  })

  test('run commands editor supports multiple rows', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    // Reach the Projects tab via the keyboard path: open settings, click the tab.
    await page.keyboard.press('ControlOrMeta+Comma')
    await page.locator('[role="tablist"]:visible [role="tab"]', { hasText: 'Projects' }).click()

    // The editor always shows at least one row; each row has its own command input.
    const commandInputs = page.locator('input[aria-label="Run command"]:visible')
    await expect(commandInputs).toHaveCount(1)

    // Adding a row gives a second independent command, proving the config is a list
    // (multiple run commands per project), not a single command field.
    await page.locator('button:visible', { hasText: 'Add command' }).click()
    await expect(commandInputs).toHaveCount(2)
    await commandInputs.nth(0).fill('npm run dev')
    await commandInputs.nth(1).fill('npm run worker')
    await expect(page.locator('input[aria-label="Port override"]:visible')).toHaveCount(2)

    // Removing a row deletes only that command.
    await page.locator('button[aria-label="Remove command"]:visible').nth(1).click()
    await expect(commandInputs).toHaveCount(1)
    await expect(commandInputs.first()).toHaveValue('npm run dev')
  })

  test('Projects is one tab among the standard settings tabs', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    await page.keyboard.press('ControlOrMeta+Comma')

    const tablist = page.locator('[role="tablist"]:visible').first()
    const firstTab = tablist.locator('[role="tab"]').first()
    await expect(firstTab).toHaveText('General')
    await expect(tablist.locator('[role="tab"]', { hasText: 'Projects' })).toBeVisible()
    // Project config is not shown until the Projects tab is opened.
    await expect(page.getByText('Run commands')).not.toBeVisible()
  })
})
