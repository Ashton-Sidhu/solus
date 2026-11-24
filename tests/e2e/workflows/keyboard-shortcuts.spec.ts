import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

test.describe('Keybindings editor', () => {
  test('Settings search and shortcut search keep separate input values', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.waitForWorkspace()

    await page.keyboard.press('ControlOrMeta+Comma')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Keybindings', exact: true }).click()
    const settingsSearch = settings.getByRole('textbox', { name: 'Search', exact: true })
    const shortcutSearch = settings.getByRole('textbox', { name: 'Search shortcuts', exact: true })

    await shortcutSearch.pressSequentially('t')
    await expect(shortcutSearch).toHaveValue('t')
    await shortcutSearch.pressSequentially('oggle sidebar')
    await expect(shortcutSearch).toHaveValue('toggle sidebar')
    await expect(settingsSearch).toHaveValue('')
    await expect(settings.getByRole('button', { name: 'Rebind Toggle sidebar', exact: true })).toBeVisible()
    await expect(settings.getByRole('button', { name: 'Rebind New session', exact: true })).toBeHidden()

    await shortcutSearch.press('Escape')
    await expect(shortcutSearch).toBeFocused()
    await expect(shortcutSearch).toHaveValue('')

    await settingsSearch.fill('toggle sidebar')
    await expect(shortcutSearch).toHaveValue('')
    await expect(settings.getByRole('button', { name: 'Rebind Toggle sidebar', exact: true })).toBeVisible()
    await expect(settings.getByRole('button', { name: 'Rebind New session', exact: true })).toBeHidden()

    await shortcutSearch.fill('new session')
    await expect(settingsSearch).toHaveValue('toggle sidebar')
    await expect(settings.getByRole('button', { name: 'Rebind New session', exact: true })).toBeVisible()
    await expect(settings.getByRole('button', { name: 'Rebind Toggle sidebar', exact: true })).toBeHidden()

    await shortcutSearch.press('Escape')
    await expect(shortcutSearch).toHaveValue('')
    await expect(settingsSearch).toHaveValue('toggle sidebar')
    await expect(settings.getByRole('button', { name: 'Rebind Toggle sidebar', exact: true })).toBeVisible()
  })

  /**
   * Intent test (Rule 6): the whole point of the editor is that a rebind takes
   * effect live and is reflected everywhere the binding is shown. This drives the
   * real record → save → propagate → reset loop: rebinding "Toggle sidebar" must
   * change the sidebar and restore the default action when reset. If any link breaks, rebinding is cosmetic-only.
   */
  test('rebinding and resetting the sidebar shortcut changes the live action and its labels', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    // The workspace opens the full tabbed settings page.
    await app.waitForWorkspace()

    // Open Settings → Keybindings tab.
    await page.keyboard.press('ControlOrMeta+Comma')
    await page.getByRole('tab', { name: 'Keybindings' }).click()

    // The keep-everything-mounted shells render several hidden copies; scope to
    // the one visible layout.
    const row = page.locator('.kb-row:visible', { hasText: 'Toggle sidebar' }).first()
    await expect(row).toBeVisible()
    const comboBtn = row.getByRole('button', { name: 'Rebind Toggle sidebar' })
    // Conventional default is ⌘B.
    await expect(comboBtn).toContainText('B')

    // Record a new combo: ⌥Y (free in the global scope).
    await comboBtn.click()
    await expect(row.locator('.kb-record')).toBeVisible()
    await page.keyboard.press('Alt+y')

    // The chip reflects the new binding.
    await expect(comboBtn).toContainText('Y')

    // The recorded shortcut must change the sidebar, not only its displayed chip.
    await page.keyboard.press('Escape')
    const expandSidebar = page.getByRole('button', { name: 'Expand sidebar', exact: true })
    await expect(expandSidebar).not.toBeVisible()
    await page.keyboard.press('Alt+y')
    await expect(expandSidebar).toBeVisible()
    await page.keyboard.press('Alt+y')
    await expect(expandSidebar).not.toBeVisible()

    // Reopen the editor and reset to default.
    await page.keyboard.press('ControlOrMeta+Comma')
    await page.getByRole('tab', { name: 'Keybindings' }).click()
    await row.getByRole('button', { name: 'Reset Toggle sidebar to default' }).click()
    await expect(comboBtn).toContainText('B')
    await page.keyboard.press('Escape')
    await page.keyboard.press('ControlOrMeta+b')
    await expect(expandSidebar).toBeVisible()
    await page.keyboard.press('ControlOrMeta+b')
    await expect(expandSidebar).not.toBeVisible()
  })
})
