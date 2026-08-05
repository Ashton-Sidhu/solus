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

  test('previews the artifact the pointer rests on, and nothing before it rests', async ({ page, electronApp }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const workspace = new WorkspacePage(page)
    await app.waitForAppReady()

    // The card is 540px wide and clamps inside the ledger — give it a window
    // where the ledger is wider than that, as any real desktop is.
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000)
    })

    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    await page.getByTestId('document-card').first().waitFor({ state: 'visible', timeout: 10_000 })

    await workspace.open()
    await workspace.waitForOpen()
    await expect(workspace.items().first()).toBeVisible({ timeout: 5_000 })

    // Nothing is reserved and nothing is clicked: with the pointer away from
    // the ledger there is no preview surface on the page at all.
    await page.mouse.move(4, 4)
    await expect(workspace.peek()).toHaveCount(0)

    // Resting on a row floats the card, reading the document's own prose — not
    // the row's snippet paraphrased — and naming the way out of it.
    await workspace.items().first().hover()
    const peek = workspace.peek()
    await expect(peek).toBeVisible({ timeout: 5_000 })
    await expect(peek).toContainText('This is a test document created by the mock agent.', {
      timeout: 5_000,
    })
    await expect(peek).toContainText('⏎ open')
  })

  test('peeking never moves the ledger selection', async ({ page, electronApp }) => {
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
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true')

    // Selection is a click and a keyboard cursor; hovering is neither. Walking
    // the ledger with the pointer must leave the keyboard's place untouched, or
    // peeking costs you your position in a 400-row list.
    await rows.nth(1).hover()
    await expect(workspace.peek()).toBeVisible({ timeout: 5_000 })
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'false')
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
