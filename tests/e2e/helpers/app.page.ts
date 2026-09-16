import type { Page } from '@playwright/test'

const ACTIVE_SHELL = '.workspace-shell'

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

  /** Waits for the desktop workspace. */
  async waitForWorkspace() {
    await this.page.locator('.workspace-layout').waitFor({ state: 'visible', timeout: 2_000 })
  }
}
