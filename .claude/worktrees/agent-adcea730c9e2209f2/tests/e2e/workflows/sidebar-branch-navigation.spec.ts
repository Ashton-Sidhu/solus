import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'

// SessionSidebar is exclusive to editor mode — all tests drive the editor shell.

test.describe('Sidebar branch navigation', () => {
  test('clicking the active branch row is a no-op (does not change the active tab)', async ({
    page,
  }) => {
    // Encodes: clicking "you are here" must never move you to a different session
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Session for no-op branch click')
    await conversation.waitForResponse()
    await app.switchToEditorMode()

    const tabCount = await app.getTabCount()

    // Find the active branch row in the sidebar
    const activeBranchRow = page.locator(`${ACTIVE_SHELL} .branch-item.active`).first()
    await expect(activeBranchRow).toBeVisible({ timeout: 3000 })
    const branchLabel = await activeBranchRow.textContent()

    // Clicking the already-active branch row should not open a new tab
    await activeBranchRow.click()

    await expect(async () => {
      expect(await app.getTabCount()).toBe(tabCount)
    }).toPass({ timeout: 2000 })

    // Active branch label must be unchanged
    const activeBranchRowAfter = page.locator(`${ACTIVE_SHELL} .branch-item.active`).first()
    expect(await activeBranchRowAfter.textContent()).toBe(branchLabel)
  })

  test('expanding a multi-session branch shows individual child session rows', async ({
    page,
  }) => {
    // Encodes: the badge that shows a count must expand to reveal pickable sessions
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('First session in branch')
    await conversation.waitForResponse()
    await app.switchToEditorMode()

    // Open a second tab (inherits same working directory / branch)
    await page.keyboard.press('ControlOrMeta+t')
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3000 })

    await conversation.typeAndSend('Second session in branch')
    await conversation.waitForResponse()

    // With 2 tabs on the same branch, there should be an expand chevron
    const expandBtn = page.locator(`${ACTIVE_SHELL} .branch-expand-btn`).first()
    await expect(expandBtn).toBeVisible({ timeout: 3000 })

    // Child rows should not exist yet
    await expect(page.locator(`${ACTIVE_SHELL} .session-child-item`)).toHaveCount(0)

    // Click the chevron to expand
    await expandBtn.click()

    // Two child rows should now be visible
    const childRows = page.locator(`${ACTIVE_SHELL} .session-child-item`)
    await expect(childRows).toHaveCount(2, { timeout: 3000 })

    // Clicking a child row activates that session
    const firstChild = childRows.first()
    await firstChild.click()
    await expect(firstChild).toHaveAttribute('data-active', 'true', { timeout: 3000 })
  })

  test('keyboard navigation: Tab to expand chevron (Enter) then Tab to child row (Enter)', async ({
    page,
  }) => {
    // Encodes: the expand button and child rows must be keyboard navigable
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Keyboard nav session one')
    await conversation.waitForResponse()
    await app.switchToEditorMode()

    // Open a second tab
    await page.keyboard.press('ControlOrMeta+t')
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3000 })

    await conversation.typeAndSend('Keyboard nav session two')
    await conversation.waitForResponse()

    // Expand chevron must be keyboard-activatable
    const expandBtn = page.locator(`${ACTIVE_SHELL} .branch-expand-btn`).first()
    await expect(expandBtn).toBeVisible({ timeout: 3000 })
    await expandBtn.focus()
    await page.keyboard.press('Enter')

    const childRows = page.locator(`${ACTIVE_SHELL} .session-child-item`)
    await expect(childRows).toHaveCount(2, { timeout: 3000 })

    // Tab into the first child and activate it with Enter
    const firstChild = childRows.first()
    await firstChild.focus()
    await page.keyboard.press('Enter')
    await expect(firstChild).toHaveAttribute('data-active', 'true', { timeout: 3000 })
  })

  test('collapsing an expanded branch hides child rows', async ({ page }) => {
    // Encodes: toggling the expand chevron twice returns to the collapsed state
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('Collapse session A')
    await conversation.waitForResponse()
    await app.switchToEditorMode()

    await page.keyboard.press('ControlOrMeta+t')
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3000 })

    await conversation.typeAndSend('Collapse session B')
    await conversation.waitForResponse()

    const expandBtn = page.locator(`${ACTIVE_SHELL} .branch-expand-btn`).first()
    await expect(expandBtn).toBeVisible({ timeout: 3000 })

    // Expand
    await expandBtn.click()
    await expect(page.locator(`${ACTIVE_SHELL} .session-child-item`)).toHaveCount(2, { timeout: 3000 })

    // Collapse
    await expandBtn.click()
    await expect(page.locator(`${ACTIVE_SHELL} .session-child-item`)).toHaveCount(0, { timeout: 2000 })
  })
})
