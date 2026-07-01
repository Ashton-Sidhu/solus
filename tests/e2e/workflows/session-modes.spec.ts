import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'
import { SidebarPage } from '../helpers/sidebar.page'

const PILL_SHELL = '.mode-shell:not(.mode-hidden) .pill-shell'
const EDITOR_SHELL = '.mode-shell:not(.mode-hidden) .editor-shell'

test.describe('Session modes — pill', () => {
  test('app starts in pill mode by default', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    const mode = await app.getViewMode()
    expect(mode).toBe('pill')
  })

  test('pill shell is visible and editor shell is hidden on startup', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await expect(page.locator(PILL_SHELL)).toBeVisible()
    await expect(page.locator('.mode-shell.mode-hidden .editor-shell')).toBeAttached()
    await expect(page.locator('.mode-shell.mode-hidden .editor-shell')).not.toBeVisible()
  })

  test('message input is accessible in pill mode', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    const input = page.locator(`${PILL_SHELL} [data-testid="message-input"]`)
    await expect(input).toBeVisible()
    await input.click()
    await page.keyboard.type('hello from pill')
    await expect(input).toContainText('hello from pill')
  })

  test('session tab created in pill mode shows conversation view', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('ping')
    await conversation.waitForResponse()

    // The conversation is rendered inside the pill shell
    const messages = await conversation.getAllAssistantMessages()
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(messages[0].length).toBeGreaterThan(0)
  })

  test('new tab button is visible inside pill shell', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    // After opening a tab, the tab strip renders in the pill shell
    await app.openNewTab()
    const sidebar = new SidebarPage(page)
    await expect(async () => {
      expect(await sidebar.getTabCount()).toBe(1)
    }).toPass({ timeout: 3000 })
  })
})

test.describe('Session modes — editor', () => {
  test('switching to editor mode makes the editor shell visible', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await app.switchToEditorMode()

    const mode = await app.getViewMode()
    expect(mode).toBe('editor')
    await expect(page.locator(EDITOR_SHELL)).toBeVisible()
    await expect(page.locator('.mode-shell.mode-hidden .pill-shell')).toBeAttached()
    await expect(page.locator('.mode-shell.mode-hidden .pill-shell')).not.toBeVisible()
  })

  test('message input is accessible in editor mode', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    const input = page.locator(`${EDITOR_SHELL} [data-testid="message-input"]`)
    await expect(input).toBeVisible()
    await input.click()
    await page.keyboard.type('hello from editor')
    await expect(input).toContainText('hello from editor')
  })

  test('session can be started and receives a response in editor mode', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    await conversation.typeAndSend('ping from editor')
    await conversation.waitForResponse()

    const messages = await conversation.getAllAssistantMessages()
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(messages[0].length).toBeGreaterThan(0)
  })

  test('session sidebar is rendered inside editor shell', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    // SessionSidebar is exclusive to EditorLayout
    await expect(page.locator(`${EDITOR_SHELL} .editor-sidebar, ${EDITOR_SHELL} [class*="sidebar"]`).first()).toBeAttached()
  })
})

test.describe('Session modes — toggling preserves session state', () => {
  test('toggling from pill to editor retains existing session messages', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // Send a message in pill mode
    await conversation.typeAndSend('remember this')
    await conversation.waitForResponse()
    const pillMessages = await conversation.getAllAssistantMessages()
    expect(pillMessages.length).toBeGreaterThanOrEqual(1)

    // Switch to editor mode
    await app.switchToEditorMode()
    await expect(page.locator(EDITOR_SHELL)).toBeVisible()

    // The same session messages should still be visible
    const editorMessages = await conversation.getAllAssistantMessages()
    expect(editorMessages.length).toBeGreaterThanOrEqual(pillMessages.length)
  })

  test('toggling from editor back to pill retains session messages', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    // Start in editor mode
    await app.switchToEditorMode()
    await conversation.typeAndSend('editor session message')
    await conversation.waitForResponse()
    const editorMessages = await conversation.getAllAssistantMessages()
    expect(editorMessages.length).toBeGreaterThanOrEqual(1)

    // Switch back to pill mode
    await app.switchToPillMode()
    await expect(page.locator(PILL_SHELL)).toBeVisible()

    // Messages should still be present
    const pillMessages = await conversation.getAllAssistantMessages()
    expect(pillMessages.length).toBeGreaterThanOrEqual(editorMessages.length)
  })

  test('mode toggle keyboard shortcut (Alt+Shift+E) cycles between modes', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    expect(await app.getViewMode()).toBe('pill')

    await app.toggleViewMode()
    expect(await app.getViewMode()).toBe('editor')

    await app.toggleViewMode()
    expect(await app.getViewMode()).toBe('pill')
  })
})
