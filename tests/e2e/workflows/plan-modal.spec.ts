import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'
import { PlanPage } from '../helpers/plan.page'

const ACTIVE_SHELL = '.workspace-shell'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

test.describe('Plan modal workflow', () => {
  test('plan-mode prompt leaves the prompt at the end when the plan completes', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const planPage = new PlanPage(page)
    const prompt = '__MOCK_PLAN__ create a migration plan'
    await app.waitForAppReady()

    await page.keyboard.press('Alt+Shift+Tab')
    await expect(page.locator(`${ACTIVE_SHELL} button`).filter({ hasText: 'Plan' }).first()).toBeVisible()

    await conversation.typeAndSend(prompt)
    await planPage.waitForPlanCard()
    await expect(page.getByTestId('plan-modal')).toBeHidden()

    const userMessages = page.locator(`${ACTIVE_TAB} [data-testid="user-message"]`)
    await expect(userMessages.last()).toContainText(prompt)
    await expect(page.locator(`${ACTIVE_TAB} [data-plan-tool-use-id]`).last()).toBeVisible()
  })

  test('starting a new session is optional in desktop and mobile layouts', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const planPage = new PlanPage(page)
    await app.waitForAppReady()

    await page.keyboard.press('Alt+Shift+Tab')
    await expect(page.locator(`${ACTIVE_SHELL} button`).filter({ hasText: 'Plan' }).first()).toBeVisible()
    await conversation.typeAndSend('__MOCK_PLAN__ create a migration plan')
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    await planPage.waitForModal()

    const newSessionOption = page.getByTestId('plan-action-new-session')
    await expect(newSessionOption).toHaveAttribute('aria-pressed', 'true')

    await newSessionOption.click()
    await expect(newSessionOption).toHaveAttribute('aria-pressed', 'false')

    await page.setViewportSize({ width: 390, height: 780 })
    await page.getByRole('button', { name: 'More approve options' }).click()
    await expect(newSessionOption).toBeVisible()
    await expect(newSessionOption).toHaveAttribute('aria-checked', 'false')

    await newSessionOption.click()
    await expect(newSessionOption).toHaveAttribute('aria-checked', 'true')
  })

  test('toolbar link popover inserts a link from keyboard submission', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const planPage = new PlanPage(page)
    const prompt = '__MOCK_PLAN__ create a migration plan'
    await app.waitForAppReady()

    await page.keyboard.press('Alt+Shift+Tab')
    await conversation.typeAndSend(prompt)
    await planPage.openFromCard()

    const editor = page.locator('.solus-doc-editor .ProseMirror').first()
    await editor.evaluate((el) => {
      const text = el.textContent ?? ''
      const start = text.indexOf('migration')
      if (start < 0) throw new Error('Expected plan text to contain "migration"')
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let offset = 0
      let node: Node | null = walker.nextNode()
      while (node) {
        const length = node.textContent?.length ?? 0
        if (start >= offset && start + 'migration'.length <= offset + length) {
          const range = document.createRange()
          range.setStart(node, start - offset)
          range.setEnd(node, start - offset + 'migration'.length)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
          return
        }
        offset += length
        node = walker.nextNode()
      }
      throw new Error('Could not select target text')
    })

    await planPage.clickToolbarLink()
    const linkInput = page.getByRole('textbox', { name: 'Link URL' })
    await expect(linkInput).toBeVisible()
    await expect(linkInput).toBeFocused()

    await planPage.submitLink('https://example.com')

    await expect(page.locator('.solus-doc-editor a[href="https://example.com"]')).toContainText('migration')
    await expect(linkInput).toBeHidden()
  })

  test('toolbar link popover cancels with Escape and restores editor focus', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    const planPage = new PlanPage(page)
    const prompt = '__MOCK_PLAN__ create a migration plan'
    await app.waitForAppReady()

    await page.keyboard.press('Alt+Shift+Tab')
    await conversation.typeAndSend(prompt)
    await planPage.openFromCard()

    const editor = page.locator('.solus-doc-editor .ProseMirror').first()
    await editor.click()
    await planPage.clickToolbarLink()

    const linkInput = page.getByRole('textbox', { name: 'Link URL' })
    await expect(linkInput).toBeVisible()
    await linkInput.press('Escape')

    await expect(linkInput).toBeHidden()
    await expect(page.locator('.solus-doc-editor a[href]')).toHaveCount(0)
    await expect(editor).toBeFocused()
  })
})
