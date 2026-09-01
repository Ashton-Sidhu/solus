import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { KeyboardShortcutsPage } from '../helpers/keyboard-shortcuts.page'

test.describe('Keyboard shortcuts modal', () => {
  test('opens via the keyboard shortcut', async ({ page }) => {
    const app = new AppPage(page)
    const shortcuts = new KeyboardShortcutsPage(page)
    await app.waitForAppReady()

    await shortcuts.open()
    await shortcuts.waitForOpen()

    expect(await shortcuts.isOpen()).toBe(true)
  })

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

  test('search filters rows — typing "new tab" shows "New tab" row and hides unrelated rows', async ({ page }) => {
    const app = new AppPage(page)
    const shortcuts = new KeyboardShortcutsPage(page)
    await app.waitForAppReady()

    await shortcuts.open()
    await shortcuts.waitForOpen()

    const allRowsBefore = await shortcuts.rows().count()
    expect(allRowsBefore).toBeGreaterThan(1)

    await shortcuts.searchInput().fill('new tab')

    await expect(shortcuts.row('New tab')).toBeVisible()

    // Rows that have nothing to do with "new tab" should be gone
    await expect(shortcuts.row('Settings')).not.toBeVisible()
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

    const rowsAfter = await shortcuts.rows().count()
    expect(rowsAfter).toBeLessThan(rowsBefore)
    await expect(shortcuts.count()).toHaveText(`${rowsAfter} shortcut${rowsAfter === 1 ? '' : 's'}`)
  })

  /**
   * Intent test (Rule 6): this asserts the BUSINESS RULE that active scopes
   * render above inactive ones — not just that the modal renders. The Diff Panel
   * scope is active because the diff panel is mounted and has pushed its scope.
   * If this rule breaks, hidden shortcuts become discoverable only by opening
   * the right context first, destroying the modal's purpose as a global reference.
   */
  test('active scope (Diff Panel) renders above Global when diff panel is open', async ({ page }) => {
    const app = new AppPage(page)
    const shortcuts = new KeyboardShortcutsPage(page)
    await app.waitForAppReady()

    // Inject a synthetic diff payload so DiffPanel mounts and pushes diff-panel scope
    await page.evaluate(() => {
      const w = window as Window & {
        solus?: {
          diff?: (...a: unknown[]) => Promise<unknown>
        }
      }
      if (!w.solus) return
      const patch = [
        'diff --git a/src/index.ts b/src/index.ts',
        '--- a/src/index.ts',
        '+++ b/src/index.ts',
        '@@ -1 +1,2 @@',
        ' context',
        '+added',
      ].join('\n')
      w.solus.diff = async () => ({ patch })
    })

    // Open the diff panel so diff-panel scope is pushed
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible({ timeout: 5_000 })

    // Now open the shortcuts modal — diff-panel scope should be snapshotted as active
    await shortcuts.open()
    await shortcuts.waitForOpen()

    const headings = shortcuts.scopeHeadings()
    const count = await headings.count()
    expect(count).toBeGreaterThanOrEqual(2)

    // The first visible scope heading must be "Diff Panel", not "Global"
    const firstHeading = await headings.first().textContent()
    expect(firstHeading?.trim()).toBe('Diff Panel')

    // Global must appear somewhere after Diff Panel
    const texts = await headings.allTextContents()
    const diffIdx = texts.findIndex(t => t.trim() === 'Diff Panel')
    const globalIdx = texts.findIndex(t => t.trim() === 'Global')
    expect(diffIdx).toBeGreaterThanOrEqual(0)
    expect(globalIdx).toBeGreaterThan(diffIdx)
  })
})

test.describe('Keybindings editor', () => {
  /**
   * Intent test (Rule 6): the whole point of the editor is that a rebind takes
   * effect live and is reflected everywhere the binding is shown. This drives the
   * real record → save → propagate → reset loop: rebinding "Toggle sidebar" must
   * update its chip, surface the new combo in the shortcuts reference modal
   * (proving the dispatcher's live override refresh), and Reset must restore the
   * conventional default. If any link breaks, rebinding is cosmetic-only.
   */
  test('rebinding an action updates the chip, the shortcuts modal, and resets', async ({ page }) => {
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

    // Close settings, open the shortcuts reference — it must show the override.
    await page.keyboard.press('Escape')
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
  })
})
