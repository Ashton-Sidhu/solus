import type { Page, Locator } from '@playwright/test'

const GALLERY = '[role="dialog"][aria-label="Folio gallery"]'

/** Interactions with the folio gallery overlay. */
export class FolioGalleryPage {
  constructor(readonly page: Page) {}

  get dialog(): Locator {
    return this.page.locator(GALLERY)
  }

  async open() {
    await this.page.keyboard.press('Alt+Shift+f')
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
    return this.dialog.locator('input[placeholder="Search documents…"]')
  }

  emptyTitle(): Locator {
    return this.dialog.locator('.empty-title')
  }

  workItems(): Locator {
    return this.dialog.locator('[role="option"]')
  }

  deleteButtons(): Locator {
    return this.dialog.getByRole('button', { name: 'Delete document' })
  }

  /** Global undo toast shown after a delete (rendered at the app root). */
  undoToast(): Locator {
    return this.page.locator('[data-sonner-toast]').filter({ hasText: 'Document deleted' })
  }

  undoToastAction(): Locator {
    return this.undoToast().getByRole('button', { name: 'Undo' })
  }

  newButton(): Locator {
    return this.dialog.getByTestId('folio-new')
  }
}
