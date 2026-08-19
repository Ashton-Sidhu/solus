import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

/**
 * Phase 5 — document comments generalize the plan comment system. A selection
 * in an open document yields a floating "Comment" button → inline form → a rail
 * entry that persists across reopen and can be sent to the agent.
 */
test.describe('Document comments', () => {
  async function openDocument(page: import('@playwright/test').Page) {
    const conversation = new ConversationPage(page)
    await conversation.typeAndSend('__MOCK_DOCUMENT__ write a project brief')
    const card = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    await card.click()
    const modal = page.getByTestId('document-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })
    return modal
  }

  async function addComment(page: import('@playwright/test').Page, modal: import('@playwright/test').Locator, text: string) {
    // Select a paragraph in the editor. Formatting has no permanent bar any
    // more — Comment lives on the selection bubble, beside the text it is about.
    const para = modal.locator('.ProseMirror p').first()
    await para.click({ clickCount: 3 })
    await page.locator('[data-testid="bubble-comment"]').click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }

  test('adding a comment shows it in the rail and persists across reopen', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    let modal = await openDocument(page)

    await addComment(page, modal, 'Tighten this section')
    const rail = page.locator('.plan-comments-rail')
    await expect(rail).toContainText('Tighten this section', { timeout: 5_000 })
    // Visible, not merely present: a card whose anchor has not been measured is
    // rendered in the margin but hidden, so matching text does not prove the
    // thread reached the reader. It must land on its line without a scroll.
    await expect(rail.locator('[data-testid="comment-thread"]').first()).toBeVisible()

    // Close and reopen — the comment persists via the annotation sidecar.
    await page.getByTestId('document-modal-close').click()
    await expect(modal).toBeHidden({ timeout: 3_000 })

    const card = page.locator(`${ACTIVE_TAB} [data-testid="document-card"]`)
    await card.click()
    modal = page.getByTestId('document-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.plan-comments-rail')).toContainText('Tighten this section', { timeout: 5_000 })
  })

  test('resolving a thread collapses it without losing it', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    const modal = await openDocument(page)

    await addComment(page, modal, 'Tighten this section')
    const rail = page.locator('.plan-comments-rail')
    await expect(rail).toContainText('Tighten this section', { timeout: 5_000 })

    await rail.locator('[data-testid="comment-thread"]').first().hover()
    await rail.locator('[data-testid="resolve-comment"]').first().click()

    // Resolved keeps a trace: one sage row that says who settled it, and a
    // "Show" that opens it again. It never disappears silently.
    await expect(rail).toContainText('Resolved', { timeout: 3_000 })
    await expect(rail).not.toContainText('Tighten this section')
    await rail.getByRole('button', { name: 'Show' }).click()
    await expect(rail).toContainText('Tighten this section')
  })

  test('send to agent puts the comment text into the conversation', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    const modal = await openDocument(page)

    await addComment(page, modal, 'Clarify the goals')
    await page.locator('[data-testid="send-comments"]').click()

    // The composed message reaches a conversation as a user message.
    await expect(async () => {
      const msgs = await page.locator(`${ACTIVE_TAB} [data-testid="user-message"]`).allTextContents()
      expect(msgs.join('\n')).toContain('Clarify the goals')
    }).toPass({ timeout: 6_000 })
  })

  test('code blocks and tables do not trap the renderer in an editor feedback loop', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    const modal = await openDocument(page)

    await modal.locator('pre code').click()
    await expect(modal.locator('.doc-code-block')).toHaveClass(/doc-code-block--focused/)

    await modal.locator('td').first().click()
    await expect(modal.locator('.ProseMirror')).toBeFocused()

    // A final unrelated action proves Chromium returned from the structured
    // block click handlers instead of spinning inside mutation/layout work.
    await page.getByTestId('document-modal-close').click()
    await expect(modal).toBeHidden({ timeout: 3_000 })
  })
})
