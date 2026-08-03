import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'
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

  test('previews the selected artifact as the document itself, not a paraphrase', async ({ page, electronApp }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const workspace = new WorkspacePage(page)
    await app.waitForAppReady()

    // The peek is a wide-layout affordance — the container query folds it away
    // below ~71rem, so pin a width the pane is guaranteed to clear.
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000)
    })

    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    await page.getByTestId('document-card').first().waitFor({ state: 'visible', timeout: 10_000 })

    await workspace.open()
    await workspace.waitForOpen()
    await expect(workspace.items().first()).toBeVisible({ timeout: 5_000 })

    // The first row is selected on open, so the peek is already loading it. It
    // must render the markdown — a heading element and a table, not a blob of
    // stripped text — which is what makes the preview a preview.
    const peek = workspace.peek()
    await expect(peek).toBeVisible()
    await expect(peek.locator('h1')).toHaveText('Mock Test Document', { timeout: 5_000 })
    await expect(peek.locator('table')).toBeVisible()
    await expect(peek.getByRole('button', { name: 'Open' })).toBeVisible()
  })

  test('keeps a hovered artifact selected while its preview loads', async ({ page, electronApp }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const workspace = new WorkspacePage(page)
    await app.waitForAppReady()

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000)
    })

    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    await page.getByTestId('document-card').first().waitFor({ state: 'visible', timeout: 10_000 })
    await conversation.typeAndSend('__MOCK_PLAN__ create a migration plan')
    await page.getByTestId('plan-card').first().waitFor({ state: 'visible', timeout: 10_000 })

    await workspace.open()
    await workspace.waitForOpen()
    const rows = workspace.items()
    await expect(rows).toHaveCount(2)

    // Prime intentional pointer movement, then move to the other row. The
    // preview begins its lazy load after 150ms; selection must survive that
    // data refresh instead of snapping back to index zero.
    await rows.first().hover()
    await rows.nth(1).hover()
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(workspace.peek().locator('h1')).toHaveText('Mock Test Document', { timeout: 5_000 })
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
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
