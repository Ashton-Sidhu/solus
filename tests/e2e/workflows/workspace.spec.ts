import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { WorkspacePage } from '../helpers/workspace.page'

test.describe('Workspace page', () => {
  test('opens via Alt+Shift+L keyboard shortcut', async ({ page }) => {
    const app = new AppPage(page)
    const workspace = new WorkspacePage(page)
    await app.waitForAppReady()

    await workspace.open()
    await workspace.waitForOpen()

    expect(await workspace.isOpen()).toBe(true)
  })

  test('shows "Nothing here yet." empty state when the mock backend has no artifacts', async ({ page }) => {
    const app = new AppPage(page)
    const workspace = new WorkspacePage(page)
    await app.waitForAppReady()

    await workspace.open()
    await workspace.waitForOpen()

    await expect(workspace.emptyTitle()).toBeVisible()
    await expect(workspace.emptyTitle()).toHaveText('Nothing here yet.')
  })

  test('closes via Escape key', async ({ page }) => {
    const app = new AppPage(page)
    const workspace = new WorkspacePage(page)
    await app.waitForAppReady()

    await workspace.open()
    await workspace.waitForOpen()
    await workspace.close()
    await workspace.waitForClosed()

    expect(await workspace.isOpen()).toBe(false)
  })

  test('renders the search field, status filter, and New button', async ({ page }) => {
    const app = new AppPage(page)
    const workspace = new WorkspacePage(page)
    await app.waitForAppReady()

    await workspace.open()
    await workspace.waitForOpen()

    await expect(workspace.searchInput()).toBeVisible()
    await expect(workspace.statusMenu()).toBeVisible()
    await expect(workspace.newButton()).toBeVisible()
  })

  test('names the open project in the rail and lists it in the switcher menu', async ({ page }) => {
    const app = new AppPage(page)
    const workspace = new WorkspacePage(page)
    await app.waitForAppReady()

    await workspace.open()
    await workspace.waitForOpen()

    // Every ledger count is relative to the project scope, so the scope has to
    // be named — and reachable — from the rail, not just implied.
    await expect(workspace.projectSwitcher()).toBeVisible()
    await workspace.projectSwitcher().click()
    // One open project in the mock backend, so no "All projects" row.
    await expect(page.getByRole('menuitemradio')).toHaveCount(1)
  })

  test('can be toggled closed and reopened via the keyboard shortcut', async ({ page }) => {
    const app = new AppPage(page)
    const workspace = new WorkspacePage(page)
    await app.waitForAppReady()

    // Open
    await workspace.open()
    await workspace.waitForOpen()
    expect(await workspace.isOpen()).toBe(true)

    // Close
    await workspace.open()
    await workspace.waitForClosed()
    expect(await workspace.isOpen()).toBe(false)

    // Reopen
    await workspace.open()
    await workspace.waitForOpen()
    expect(await workspace.isOpen()).toBe(true)
  })
})
