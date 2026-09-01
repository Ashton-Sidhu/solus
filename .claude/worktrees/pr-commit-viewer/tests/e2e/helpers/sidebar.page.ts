import type { Page } from '@playwright/test'

/** Interactions with the tab strip and session sidebar. */
export class SidebarPage {
  constructor(readonly page: Page) {}

  async getTabCount(): Promise<number> {
    return this.page.getByTestId('tab-item').count()
  }

  async openSessionPicker() {
    await this.page.keyboard.press('ControlOrMeta+p')
  }

  async getTabLabels(): Promise<string[]> {
    const tabs = this.page.getByTestId('tab-item')
    const count = await tabs.count()
    const labels: string[] = []
    for (let i = 0; i < count; i++) {
      labels.push(await tabs.nth(i).getAttribute('aria-label') ?? '')
    }
    return labels
  }
}
