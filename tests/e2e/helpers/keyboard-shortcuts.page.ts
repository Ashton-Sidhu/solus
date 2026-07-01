import type { Page, Locator } from '@playwright/test'

const DIALOG = '[role="dialog"][aria-label="Keyboard shortcuts"]'

/** Interactions with the keyboard shortcuts help modal. */
export class KeyboardShortcutsPage {
  constructor(readonly page: Page) {}

  get dialog(): Locator {
    return this.page.locator(DIALOG)
  }

  async open() {
    await this.page.keyboard.press('ControlOrMeta+/')
  }

  async close() {
    await this.page.keyboard.press('Escape')
  }

  async waitForOpen(timeout = 5_000) {
    await this.dialog.waitFor({ state: 'visible', timeout })
  }

  async waitForClosed(timeout = 5_000) {
    await this.dialog.waitFor({ state: 'hidden', timeout })
  }

  async isOpen(): Promise<boolean> {
    return this.dialog.isVisible()
  }

  searchInput(): Locator {
    return this.dialog.locator('input[name="shortcuts-search"]')
  }

  scopeHeadings(): Locator {
    return this.dialog.locator('.shortcuts-scope-label')
  }

  rows(): Locator {
    return this.dialog.locator('.shortcuts-row')
  }

  row(label: string): Locator {
    // A binding (e.g. "New tab") can appear in more than one scope, so scope to
    // the first match to keep assertions out of strict-mode violations.
    return this.dialog.locator('.shortcuts-row-label', { hasText: label }).first()
  }

  /** Footer summary text, e.g. "12 shortcuts". */
  count(): Locator {
    return this.dialog.locator('.shortcuts-count')
  }
}
