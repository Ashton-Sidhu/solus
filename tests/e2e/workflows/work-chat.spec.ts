import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'
import { FolioGalleryPage } from '../helpers/folio-gallery.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
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

  test('open chat from FolioGallery with new chat option', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const gallery = new FolioGalleryPage(page)
    await app.waitForAppReady()

    // Create a document
    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })

    // Open Folio gallery
    await gallery.open()
    await gallery.waitForOpen()

    // Find the chat button in the work card
    const workItems = gallery.workItems()
    const firstWorkItem = workItems.first()
    await expect(firstWorkItem).toBeVisible()

    // Hover to reveal the chat button
    await firstWorkItem.hover()
    const chatBtn = firstWorkItem.locator('button[aria-label="Open chat"]')
    await expect(chatBtn).toBeVisible()

    // Click the chat button
    await chatBtn.click()

    // The WorkChatMenu should appear
    const chatMenu = page.locator('.work-chat-menu')
    await expect(chatMenu).toBeVisible()

    // Click "New chat"
    const newChatBtn = chatMenu.locator('button').nth(1) // Second button is "New chat"
    await newChatBtn.click()

    // A new tab should be created
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3_000 })

    // The document should be in the secondary pane
    const documentModal = page.getByTestId('document-modal')
    await expect(documentModal).toBeVisible()

    // The new tab shows the bound-work chip for the attached work
    await expect(page.getByTestId('bound-work-chip')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('bound-work-chip')).toContainText('Mock Test Document')
  })

  test('document modal has chat button that opens menu', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // Create a document
    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })

    // Click the card to open the modal
    await documentCard.click()

    const modal = page.getByTestId('document-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // The chat button should be in the header
    const chatBtn = modal.locator('button[data-testid="open-chat"]')
    await expect(chatBtn).toBeVisible()

    // Click the chat button
    await chatBtn.click()

    // The WorkChatMenu should appear
    const chatMenu = page.locator('.work-chat-menu')
    await expect(chatMenu).toBeVisible()

    // Menu should have two options
    const menuItems = chatMenu.locator('button')
    await expect(menuItems).toHaveCount(2)
  })

  test('work chat menu closes on selection', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // Create a document
    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })

    // Open modal and menu
    await documentCard.click()
    const modal = page.getByTestId('document-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    const chatBtn = modal.locator('button[data-testid="open-chat"]')
    await chatBtn.click()

    const chatMenu = page.locator('.work-chat-menu')
    await expect(chatMenu).toBeVisible()

    // Click "New chat"
    const newChatBtn = chatMenu.locator('button').nth(1)
    await newChatBtn.click()

    // Menu should close
    await expect(chatMenu).toBeHidden({ timeout: 1_000 })
  })

  test('opening a new chat for a work binds the session (chip visible)', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })
    await documentCard.click()

    const modal = page.getByTestId('document-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    await modal.locator('button[data-testid="open-chat"]').click()
    const chatMenu = page.locator('.work-chat-menu')
    await expect(chatMenu).toBeVisible()
    await chatMenu.locator('button').nth(1).click() // New chat

    // The composer shows the bound-work indicator for the new session.
    await expect(page.getByTestId('bound-work-chip')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('bound-work-chip')).toContainText('Mock Test Document')
  })

  test('work chat menu responds to keyboard navigation', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // Create a document
    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })

    // Open modal and menu
    await documentCard.click()
    const modal = page.getByTestId('document-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    const chatBtn = modal.locator('button[data-testid="open-chat"]')
    await chatBtn.click()

    const chatMenu = page.locator('.work-chat-menu')
    await expect(chatMenu).toBeVisible()

    // Press down arrow to navigate to second option
    await page.keyboard.press('ArrowDown')

    // The second button should be focused
    const buttons = chatMenu.locator('button')
    const secondBtn = buttons.nth(1)
    await expect(secondBtn).toBeFocused()

    // Close the menu with Escape
    await page.keyboard.press('Escape')
    await expect(chatMenu).toBeHidden({ timeout: 1_000 })
  })
})

test.describe('Work chat keyboard shortcuts', () => {
  test('⌥C opens chat menu from document modal', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // Create a document
    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const documentCard = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await documentCard.waitFor({ state: 'visible', timeout: 10_000 })

    // Open modal
    await documentCard.click()
    const modal = page.getByTestId('document-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Press ⌥C to open the menu
    await page.keyboard.press('Alt+c')

    // The WorkChatMenu should appear
    const chatMenu = page.locator('.work-chat-menu')
    await expect(chatMenu).toBeVisible({ timeout: 1_000 })
  })
})
