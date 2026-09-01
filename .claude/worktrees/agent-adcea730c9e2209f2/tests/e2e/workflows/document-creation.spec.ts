import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'
import { FolioGalleryPage } from '../helpers/folio-gallery.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
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
  })

  test('clicking document card opens the document modal', async ({ page }) => {
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

    // The document modal is built on the shared DocumentShell — it must render the
    // same formatting toolbar and editor region that the plan modal does. This is
    // what would regress if the document path stopped composing the shared shell.
    await expect(modal.locator('.doc-shell-toolbar')).toBeVisible()
    await expect(modal.locator('[aria-label="Document"]')).toBeVisible()
  })

  test('document modal can be closed', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')

    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })
    await documentCard.click()

    const modal = page.getByTestId('document-modal')
    await modal.waitFor({ state: 'visible', timeout: 5_000 })

    // Close via button
    await page.getByTestId('document-modal-close').click()
    await expect(modal).toBeHidden({ timeout: 3_000 })
  })
})

test.describe('Folio gallery', () => {
  test('opens via Alt+Shift+F keyboard shortcut', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new FolioGalleryPage(page)
    await app.waitForAppReady()

    await gallery.open()
    await gallery.waitForOpen()

    expect(await gallery.isOpen()).toBe(true)
  })

  test('shows empty state when no documents exist', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new FolioGalleryPage(page)
    await app.waitForAppReady()

    await gallery.open()
    await gallery.waitForOpen()

    await expect(gallery.emptyTitle()).toBeVisible()
    await expect(gallery.emptyTitle()).toHaveText('No documents yet.')
  })

  test('closes via Escape key', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new FolioGalleryPage(page)
    await app.waitForAppReady()

    await gallery.open()
    await gallery.waitForOpen()
    await gallery.close()
    await gallery.waitForClosed()

    expect(await gallery.isOpen()).toBe(false)
  })

  test('renders search input', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new FolioGalleryPage(page)
    await app.waitForAppReady()

    await gallery.open()
    await gallery.waitForOpen()

    await expect(gallery.searchInput()).toBeVisible()
  })

  test('can be toggled closed and reopened via the keyboard shortcut', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new FolioGalleryPage(page)
    await app.waitForAppReady()

    // Open
    await gallery.open()
    await gallery.waitForOpen()
    expect(await gallery.isOpen()).toBe(true)

    // Close via shortcut
    await gallery.open()
    await gallery.waitForClosed()
    expect(await gallery.isOpen()).toBe(false)

    // Reopen
    await gallery.open()
    await gallery.waitForOpen()
    expect(await gallery.isOpen()).toBe(true)
  })

  test('shows saved document after document creation', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const gallery = new FolioGalleryPage(page)
    await app.waitForAppReady()

    // Create a document via the mock prompt
    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })

    // Open folio gallery
    await gallery.open()
    await gallery.waitForOpen()

    // Document should appear in the gallery
    const items = gallery.workItems()
    await expect(items.first()).toBeVisible({ timeout: 5_000 })
    await expect(items.first()).toContainText('Mock Test Document')
  })
})
