import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'
import { WorkspacePage } from '../helpers/workspace.page'

const ACTIVE_SHELL = '.workspace-shell'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

test.describe('Document creation workflow', () => {
  test('document card appears in conversation after __MOCK_DOCUMENT__ prompt', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')

    // A document card should appear in the conversation thread
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await expect(documentCard).toBeVisible({ timeout: 10_000 })

    // The card should display the document title
    await expect(documentCard).toContainText('Mock Test Document')

    // Publishing is a card action, so the user does not need to open the
    // document before choosing Google Drive or Confluence.
    const publishButton = documentCard.getByTestId('work-publish-menu')
    await expect(publishButton).toHaveText('Publish')
    await publishButton.click()
    const publishMenu = page.getByRole('menu')
    await expect(publishMenu).toContainText('Google Drive')
    await expect(publishMenu).toContainText('Confluence')
  })

  test('opens the document editor from its card and returns to the conversation when closed', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')

    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })

    // Click the card to open the document modal
    await documentCard.click()

    const modal = page.getByTestId('document-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    await expect(modal.locator('[aria-label="Document"]')).toBeVisible()

    await page.getByTestId('document-modal-close').click()
    await expect(modal).toBeHidden({ timeout: 3_000 })
    await expect(documentCard).toBeVisible()
  })
})

test.describe('Workspace page', () => {
  test('shows saved document after document creation', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const gallery = new WorkspacePage(page)
    await app.waitForAppReady()

    // Create a document via the mock prompt
    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })

    // Open the workspace page
    await gallery.open()
    await gallery.waitForOpen()

    // Document should appear in the ledger
    const items = gallery.items()
    await expect(items.first()).toBeVisible({ timeout: 5_000 })
    await expect(items.first()).toContainText('Mock Test Document')
  })
})
