import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { KeyboardShortcutsPage } from '../helpers/keyboard-shortcuts.page'

test.describe('Keyboard shortcuts modal', () => {
  test('closes via Escape key', async ({ page }) => {
    const app = new AppPage(page)
    const shortcuts = new KeyboardShortcutsPage(page)
    await app.waitForAppReady()

    await shortcuts.open()
    await shortcuts.waitForOpen()
    await shortcuts.close()
    await shortcuts.waitForClosed()

    expect(await shortcuts.isOpen()).toBe(false)
  })

  test('search input is autofocused on open', async ({ page }) => {
    const app = new AppPage(page)
    const shortcuts = new KeyboardShortcutsPage(page)
    await app.waitForAppReady()

    await shortcuts.open()
    await shortcuts.waitForOpen()

    await expect(shortcuts.searchInput()).toBeFocused()
  })

  /**
   * Intent test (Rule 6): the diagram canvas keys live in the shared manifest so
   * they show up in this global reference even when no diagram is open (as an
   * inactive scope). Before the migration they were a private keydown handler
   * and invisible here — the exact gap a user hit. Searching the catalog must
   * surface them, or the shortcuts are undiscoverable again.
   */
  test('diagram shortcuts are catalogued even with no diagram open', async ({ page }) => {
    const app = new AppPage(page)
    const shortcuts = new KeyboardShortcutsPage(page)
    await app.waitForAppReady()

    await shortcuts.open()
    await shortcuts.waitForOpen()

    // Narrow to the Diagram scope so the assertions don't collide with same-named
    // rows in other scopes, then confirm the real canvas commands are listed.
    await shortcuts.searchInput().fill('diagram')
    await expect(shortcuts.scopeHeadings().filter({ hasText: 'Diagram' })).toBeVisible()
    await expect(shortcuts.row('Add node')).toBeVisible()
    await expect(shortcuts.row('Select all')).toBeVisible()
    await expect(shortcuts.row('Nudge up')).toBeVisible()
  })

  /**
   * Intent test (Rule 6): the footer count is the user's signal that filtering
   * actually narrowed the list. If it stayed fixed (or showed the full catalog
   * while rows were hidden), the search would feel broken and users couldn't
   * trust that a missing shortcut truly doesn't exist. The count MUST track the
   * number of rows actually rendered.
   */
  test('footer count matches visible rows and shrinks when filtering', async ({ page }) => {
    const app = new AppPage(page)
    const shortcuts = new KeyboardShortcutsPage(page)
    await app.waitForAppReady()

    await shortcuts.open()
    await shortcuts.waitForOpen()

    const rowsBefore = await shortcuts.rows().count()
    await expect(shortcuts.count()).toHaveText(`${rowsBefore} shortcut${rowsBefore === 1 ? '' : 's'}`)

    await shortcuts.searchInput().fill('new tab')
    await expect(shortcuts.row('New tab')).toBeVisible()

    await expect(shortcuts.row('Settings')).not.toBeVisible()
    const rowsAfter = await shortcuts.rows().count()
    expect(rowsAfter).toBeLessThan(rowsBefore)
    await expect(shortcuts.count()).toHaveText(`${rowsAfter} shortcut${rowsAfter === 1 ? '' : 's'}`)
  })
})

test.describe('Keybindings editor', () => {
  /**
   * Intent test (Rule 6): the whole point of the editor is that a rebind takes
   * effect live and is reflected everywhere the binding is shown. This drives the
   * real record → save → propagate → reset loop: rebinding "Toggle sidebar" must
   * change the sidebar, show the new combo in the shortcuts reference,
   * and restore the default action when reset. If any link breaks, rebinding is cosmetic-only.
   */
  test('rebinding and resetting the sidebar shortcut changes the live action and its labels', async ({ page }) => {
    const app = new AppPage(page)
    const shortcuts = new KeyboardShortcutsPage(page)
    await app.waitForAppReady()
    // The tabbed settings page (vs. the pill-mode popover) shows in editor mode.
    await app.switchToEditorMode()

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
    const expandSidebar = page.locator('.editor-shell .tab-chrome-lead[aria-label="Expand sidebar"]')
    await expect(expandSidebar).not.toBeVisible()
    await page.keyboard.press('Alt+y')
    await expect(expandSidebar).toBeVisible()
    await page.keyboard.press('Alt+y')
    await expect(expandSidebar).not.toBeVisible()

    // The reference must show the same override.
    await shortcuts.open()
    await shortcuts.waitForOpen()
    await shortcuts.searchInput().fill('Toggle sidebar')
    const modalRow = shortcuts.row('Toggle sidebar').locator('xpath=..')
    await expect(modalRow.locator('.shortcuts-row-keys')).toContainText('Y')
    await shortcuts.close()
    await shortcuts.waitForClosed()

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
