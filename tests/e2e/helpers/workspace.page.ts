import type { Page, Locator } from '@playwright/test'

const WORKSPACE = '[role="dialog"][aria-label="Workspace"]'

/** Interactions with the Workspace page (the unified plans + docs + diagrams ledger). */
export class WorkspacePage {
  constructor(readonly page: Page) {}

  get dialog(): Locator {
    return this.page.locator(WORKSPACE)
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
    return this.dialog.locator('input[placeholder^="Search"]')
  }

  emptyTitle(): Locator {
    return this.dialog.locator('[data-slot="empty-title"]')
  }

  /** Every ledger row — plans, docs and diagrams share the same row shape. */
  items(): Locator {
    return this.dialog.locator('[role="option"]')
  }

  /** Delete sits at the row's outer edge, past status and time — far from the
   *  pin, so a missed pin cannot destroy a document. */
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
    return this.dialog.getByTestId('workspace-new')
  }

  /** The rail's project scope control — every ledger count is relative to it. */
  projectSwitcher(): Locator {
    return this.dialog.getByTestId('workspace-project-switcher')
  }

  statusMenu(): Locator {
    return this.dialog.getByRole('button', { name: 'Filter by status' })
  }

  /** The hover peek — a transient card anchored to a row, portalled to the body
   *  so it is never clipped by the ledger. It exists only while the pointer
   *  rests on a row (380ms), so callers must hover first. */
  peek(): Locator {
    return this.page.getByTestId('workspace-peek')
  }
}
