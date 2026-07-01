import type { Page } from '@playwright/test'

// Targets elements only in the currently active (non-hidden) mode shell.
// Both EditorLayout and PillLayout share the same session data, so we scope
// to the visible container to avoid ambiguous locators.
const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

/** Interactions with the message input and conversation thread. */
export class ConversationPage {
  constructor(readonly page: Page) {}

  async typeMessage(text: string) {
    const input = this.page.locator(`${ACTIVE_SHELL} [data-testid="message-input"]`)
    await input.click()
    await input.pressSequentially(text)
  }

  async sendMessage() {
    await this.page.keyboard.press('Enter')
  }

  async typeAndSend(text: string) {
    await this.typeMessage(text)
    await this.sendMessage()
  }

  async waitForResponse(timeout = 10_000) {
    // Wait until the active tab has at least one assistant message with non-empty text.
    await this.page.waitForFunction(
      (sel) => {
        const msgs = document.querySelectorAll(sel)
        return [...msgs].some((m) => (m.textContent?.trim().length ?? 0) > 0)
      },
      `${ACTIVE_TAB} [data-testid="assistant-message"]`,
      { timeout },
    )
  }

  async getLastAssistantMessage(): Promise<string> {
    const selector = `${ACTIVE_TAB} [data-testid="assistant-message"]`
    await this.page.waitForFunction(
      (sel) => {
        const els = [...document.querySelectorAll(sel)]
        return els.length > 0 && (els[els.length - 1].textContent?.trim().length ?? 0) > 0
      },
      selector,
      { timeout: 10_000 },
    )
    return this.page.evaluate((sel) => {
      const els = [...document.querySelectorAll(sel)]
      return els[els.length - 1]?.textContent?.trim() ?? ''
    }, selector)
  }

  async getAllAssistantMessages(): Promise<string[]> {
    const selector = `${ACTIVE_TAB} [data-testid="assistant-message"]`
    return this.page.evaluate((sel) => {
      return [...document.querySelectorAll(sel)]
        .filter((el) => (el.textContent?.trim().length ?? 0) > 0)
        .map((el) => el.textContent?.trim() ?? '')
    }, selector)
  }

  async clickSendButton() {
    await this.page.locator(`${ACTIVE_SHELL} [data-testid="send-button"]`).first().click()
  }
}
