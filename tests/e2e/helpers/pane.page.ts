import type { Page } from '@playwright/test'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'

/** Interactions with the two-pane layout in editor mode. */
export class PanePage {
  constructor(readonly page: Page) {}

  /** Clicks the pane chrome's Open-in-split / Move-to-main-pane toggle. */
  async openInSplit() {
    await this.page.getByTestId('open-in-split').click()
  }

  /** Returns true when a secondary pane wrap element is visible in the layout. */
  async isSecondaryPaneVisible(): Promise<boolean> {
    return this.page.locator(`${ACTIVE_SHELL} .secondary-pane-wrap`).isVisible()
  }

  /** Waits for the secondary pane to appear. */
  async waitForSecondaryPane(timeout = 5_000) {
    await this.page
      .locator(`${ACTIVE_SHELL} .secondary-pane-wrap`)
      .waitFor({ state: 'visible', timeout })
  }

  /** Returns true when at least one conversation tab slot is visible (not hidden). */
  async isConversationVisible(): Promise<boolean> {
    return this.page
      .locator(`${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`)
      .first()
      .isVisible()
  }

  /** Returns true when the input dock is visible (not hidden). */
  async isInputDockVisible(): Promise<boolean> {
    return this.page.locator(`${ACTIVE_SHELL} .input-dock:not(.mode-hidden)`).isVisible()
  }

  /** Reads the label of the split toggle (reflects which slot the artifact is in). */
  async toggleLabel(): Promise<string> {
    return (await this.page.getByTestId('open-in-split').getAttribute('aria-label')) ?? ''
  }

  /**
   * Opens the single-file editor in the secondary pane via the file-preview
   * event path. Doesn't depend on a changed-files git fixture.
   */
  async triggerFilePreview(path = 'README.md') {
    await this.page.evaluate((p) => {
      window.dispatchEvent(new CustomEvent('solus:preview-file', { detail: { path: p } }))
    }, path)
  }

  /** Closes the files browser or single-file editor via the pane chrome. */
  async closeFilesPane() {
    await this.page
      .locator(`${ACTIVE_SHELL} button[aria-label="Close files"], ${ACTIVE_SHELL} button[aria-label="Close file editor"]`)
      .click()
  }
}
