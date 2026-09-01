import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'
import { FolioGalleryPage } from '../helpers/folio-gallery.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

/**
 * Agent work tools. The mock backend's __MOCK_DOCUMENT__ drives a streamed
 * create_work tool call that persists under the fixed id `mock-work-001`; later
 * __MOCK_WORK_UPDATE__ / __MOCK_WORK_TOOL_PERMISSION__ revise that SAME work via
 * update_work, proving create→update round-trips against one persisted id.
 */
test.describe('Agent work tools — create + generating skeleton', () => {
  test('create_work shows a generating skeleton, then swaps in the finished card', async ({ page }) => {
    const conversation = new ConversationPage(page)
    await new AppPage(page).waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT_SLOW__ write a brief')

    // While the tool call is in flight, a generating skeleton stands in — no
    // content streams into it.
    const skeleton = page.locator(`${ACTIVE_TAB} [data-testid="work-generating"]`)
    await skeleton.waitFor({ state: 'visible', timeout: 10_000 })

    // On work_created the skeleton is replaced by the finished document card.
    const card = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await expect(card).toContainText('test document created by the mock agent', { timeout: 8_000 })
    await expect(skeleton).toHaveCount(0, { timeout: 8_000 })
  })

  test('create then update_work revises the same card in place', async ({ page }) => {
    const conversation = new ConversationPage(page)
    await new AppPage(page).waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ create a brief')
    const card = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    await expect(card).toContainText('Mock Test Document', { timeout: 5_000 })

    // update_work revises the work in place — no second card is created.
    await conversation.typeAndSend('__MOCK_WORK_UPDATE__ tighten it')
    await conversation.waitForResponse()
    await expect(card).toContainText('revised this document in place', { timeout: 6_000 })
    await expect(page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)).toHaveCount(1)
  })
})

test.describe('Agent work tools — live update round-trip', () => {
  test('agent update refreshes the gallery preview in place', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const gallery = new FolioGalleryPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ create a brief')
    await page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`).waitFor({ state: 'visible', timeout: 10_000 })

    // The agent revises the work mid-turn.
    await conversation.typeAndSend('__MOCK_WORK_UPDATE__ tighten it')
    await conversation.waitForResponse()

    await gallery.open()
    await gallery.waitForOpen()
    const item = gallery.workItems().first()
    await expect(item).toBeVisible({ timeout: 5_000 })
    // The preview reflects the agent's new content, not the original.
    await expect(item).toContainText('revised this document', { timeout: 5_000 })
  })

  test('delete removes the work and offers undo', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const gallery = new FolioGalleryPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ create a brief')
    await page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`).waitFor({ state: 'visible', timeout: 10_000 })

    await gallery.open()
    await gallery.waitForOpen()
    await gallery.workItems().first().hover()

    // Deleting hides the work and surfaces an undo toast — no second confirm gate.
    // The on-disk delete is deferred until the toast dismisses, so undo can bring
    // it straight back. The work leaves the live list immediately.
    await gallery.deleteButtons().first().click()
    await expect(gallery.undoToast()).toBeVisible({ timeout: 3_000 })
    await expect(gallery.workItems()).toHaveCount(0)

    // Undo restores it to the live list.
    await gallery.undoToastAction().click()
    await expect(gallery.workItems().first()).toContainText('Mock Test Document')
  })

  test('update_work permission: approve applies the change', async ({ page }) => {
    const conversation = new ConversationPage(page)
    const gallery = new FolioGalleryPage(page)
    await new AppPage(page).waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ create a brief')
    await page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`).waitFor({ state: 'visible', timeout: 10_000 })

    await conversation.typeAndSend('__MOCK_WORK_TOOL_PERMISSION__ revise it')
    const card = page.locator(`${ACTIVE_TAB} [data-testid="permission-card"]`)
    await card.waitFor({ state: 'visible', timeout: 8_000 })
    // Allow is the first option.
    await card.locator('[data-testid="permission-option"]').first().click()
    await conversation.waitForResponse()

    await gallery.open()
    await gallery.waitForOpen()
    await expect(gallery.workItems().first()).toContainText('Approved via permission', { timeout: 5_000 })
  })

  test('update_work permission: deny leaves the work unchanged', async ({ page }) => {
    const conversation = new ConversationPage(page)
    const gallery = new FolioGalleryPage(page)
    await new AppPage(page).waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ create a brief')
    await page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`).waitFor({ state: 'visible', timeout: 10_000 })

    await conversation.typeAndSend('__MOCK_WORK_TOOL_PERMISSION__ revise it')
    const card = page.locator(`${ACTIVE_TAB} [data-testid="permission-card"]`)
    await card.waitFor({ state: 'visible', timeout: 8_000 })
    // Deny is the last option.
    await card.locator('[data-testid="permission-option"]').last().click()
    await conversation.waitForResponse()

    await gallery.open()
    await gallery.waitForOpen()
    const item = gallery.workItems().first()
    await expect(item).toBeVisible({ timeout: 5_000 })
    await expect(item).not.toContainText('Approved via permission')
  })
})

test.describe('Agent work tools — open viewer (editor mode)', () => {
  test('a clean open document live-refreshes when the agent updates it', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ create a brief')
    const card = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    await card.click()

    const modal = page.getByTestId('document-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })
    await expect(modal).toContainText('Mock Test Document')

    // Agent updates it while it's open and clean → silent refresh, no banner.
    await conversation.typeAndSend('__MOCK_WORK_UPDATE__ tighten it')
    await expect(modal).toContainText('revised this document in place', { timeout: 6_000 })
    await expect(page.getByTestId('work-refresh')).toHaveCount(0)
  })

  test('a dirty open document shows a refresh banner instead of clobbering edits', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ create a brief')
    const card = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    await card.click()

    const modal = page.getByTestId('document-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // User edits the document (marks the shell dirty).
    const editor = modal.locator('.ProseMirror').first()
    await editor.click()
    await page.keyboard.type(' MY LOCAL EDIT')

    // Agent updates the same work mid-edit → banner, no clobber.
    await conversation.typeAndSend('__MOCK_WORK_UPDATE__ tighten it')
    await expect(page.getByTestId('work-refresh')).toBeVisible({ timeout: 6_000 })
    await expect(modal).toContainText('MY LOCAL EDIT')

    // Refreshing pulls the agent's version in.
    await page.getByTestId('work-refresh').click()
    await expect(modal).toContainText('revised this document in place', { timeout: 6_000 })
  })

  test('"View changes" shows the agent\'s revision diff', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ create a brief')
    const card = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    await card.click()
    const modal = page.getByTestId('document-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Agent update snapshots the prior version → "View changes" appears in the
    // overflow (⋯) menu.
    await conversation.typeAndSend('__MOCK_WORK_UPDATE__ tighten it')
    await page.getByTestId('work-actions-menu').click()
    const viewChanges = page.getByTestId('view-changes')
    await expect(viewChanges).toBeVisible({ timeout: 6_000 })
    await viewChanges.click()

    // The diff overlay shows the new content line.
    await expect(page.locator('.wha-diff-panel')).toBeVisible({ timeout: 3_000 })
    await expect(page.locator('.wha-diff-panel')).toContainText('updated')
  })
})
