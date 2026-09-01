import type { Page, Locator } from '@playwright/test'

const GALLERY = '[role="dialog"][aria-label="Plans gallery"]'

/** Interactions with the plan gallery overlay. */
export class PlanGalleryPage {
  constructor(readonly page: Page) {}

  get dialog(): Locator {
    return this.page.locator(GALLERY)
  }

  async open() {
    await this.page.keyboard.press('Alt+Shift+l')
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
    return this.dialog.locator('input[placeholder="Search plans…"]')
  }

  filterTab(label: RegExp | string): Locator {
    return this.dialog.getByRole('button', { name: label })
  }

  emptyTitle(): Locator {
    return this.dialog.locator('.empty-title')
  }

  planCards(): Locator {
    return this.dialog.locator('[role="option"]')
  }

  bookmarkedButton(): Locator {
    return this.dialog.getByRole('button', { name: 'Bookmarked plans' })
  }
}
