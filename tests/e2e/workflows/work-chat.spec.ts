import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'
import { WorkspacePage } from '../helpers/workspace.page'

const ACTIVE_SHELL = '.workspace-shell'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

test.describe('Work chat workflow', () => {
  test('pop-out button in document card moves work to secondary pane', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // Create a document via the mock prompt
    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')

    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })

    // Click the pop-out button (ArrowLineRightIcon)
    const popOutBtn = documentCard.locator('button').first()
    await popOutBtn.click()

    // The document should now appear in the secondary pane
    const documentModal = page.getByTestId('document-modal')
    await expect(documentModal).toBeVisible({ timeout: 5_000 })

    // The conversation should still be visible and editable in the primary pane
    const conversationView = page.locator(`${ACTIVE_TAB} .conversation-root`)
    await expect(conversationView).toBeVisible()

    // Input bar should be focused and ready for typing
    const inputBar = page.locator('.input-bar')
    await expect(inputBar).toBeVisible()
  })

  test('a work page docks one chat glyph that opens into a composer', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })
    await documentCard.click()
    await expect(page.getByTestId('document-modal')).toBeVisible({ timeout: 5_000 })

    // At rest the page carries one glyph, not a composer over the document.
    const glyph = page.getByTestId('open-page-composer')
    await expect(glyph).toBeVisible()
    await expect(page.getByTestId('page-composer')).toHaveCount(0)

    await glyph.click()
    const composer = page.getByTestId('page-composer')
    await expect(composer).toBeVisible()
    await expect(composer.getByTestId('message-input')).toBeFocused()

    // Escape on an empty composer folds it back to the glyph.
    await page.keyboard.press('Escape')
    await expect(composer).toBeHidden({ timeout: 1_000 })
    await expect(glyph).toBeVisible()
  })

  test('sending from the docked composer opens a bound session beside the work', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const workspace = new WorkspacePage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })

    // Opened from the Workspace ledger, the document takes the leading pane.
    await workspace.open()
    await workspace.waitForOpen()
    const firstItem = workspace.items().first()
    await expect(firstItem).toBeVisible()
    await firstItem.click()
    await expect(page.getByTestId('document-modal')).toBeVisible({ timeout: 5_000 })

    await page.getByTestId('open-page-composer').click()
    const input = page.getByTestId('page-composer').getByTestId('message-input')
    await input.pressSequentially('tighten the intro')
    await page.keyboard.press('Enter')

    // A new session starts and its conversation pops out beside the document,
    // which stays where it was.
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3_000 })
    await expect(page.getByTestId('document-modal')).toBeVisible()
    await expect(page.getByTestId('page-composer')).toHaveCount(0)

    // The new session is bound to the work it was started from.
    await expect(page.getByTestId('bound-work-chip')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('bound-work-chip')).toContainText('Mock Test Document')
  })
})
