import type { Page } from '@playwright/test'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'

/** Top-level app interactions that span the whole window. */
export class AppPage {
  constructor(readonly page: Page) {}

  async openNewTab() {
    await this.page.getByTestId('new-tab-button').click()
  }

  async switchToTab(index: number) {
    const tabs = this.page.getByTestId('tab-item')
    await tabs.nth(index).click()
  }

  async closeActiveTab() {
    const activeTab = this.page.locator('[data-testid="tab-item"][aria-selected="true"]')
    await activeTab.getByLabel('Close tab').click()
  }

  async getTabCount(): Promise<number> {
    return this.page.getByTestId('tab-item').count()
  }

  async waitForAppReady() {
    await this.page
      .locator(`${ACTIVE_SHELL} [data-testid="message-input"]`)
      .waitFor({ state: 'visible', timeout: 10_000 })
  }

  /** Returns the currently active view mode by inspecting which shell is visible. */
  async getViewMode(): Promise<'pill' | 'editor'> {
    const pillVisible = await this.page.locator('.mode-shell:not(.mode-hidden) .pill-shell').isVisible()
    return pillVisible ? 'pill' : 'editor'
  }

  /** Toggles between pill and editor mode via the keyboard shortcut (Alt+Shift+E). */
  async toggleViewMode() {
    const before = await this.getViewMode()
    await this.page.keyboard.press('Alt+Shift+E')
    const targetSelector = before === 'pill'
      ? '.mode-shell:not(.mode-hidden) .editor-shell'
      : '.mode-shell:not(.mode-hidden) .pill-shell'
    await this.page.locator(targetSelector).waitFor({ state: 'visible', timeout: 2_000 })
  }

  /** Switches to editor mode, toggling if necessary. */
  async switchToEditorMode() {
    if ((await this.getViewMode()) !== 'editor') await this.toggleViewMode()
  }

  /** Switches to pill mode, toggling if necessary. */
  async switchToPillMode() {
    if ((await this.getViewMode()) !== 'pill') await this.toggleViewMode()
  }
}
