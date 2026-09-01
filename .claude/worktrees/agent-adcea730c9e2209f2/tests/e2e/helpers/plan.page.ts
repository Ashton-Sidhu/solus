import type { Page } from '@playwright/test'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

/** Interactions with the plan card in the conversation and the plan modal. */
export class PlanPage {
  constructor(readonly page: Page) {}

  /** Waits for a plan card to appear in the active conversation thread. */
  async waitForPlanCard(timeout = 10_000) {
    await this.page.locator(`${ACTIVE_TAB} [data-plan-tool-use-id]`).waitFor({ state: 'visible', timeout })
  }

  /** Clicks the Expand button on a plan card to open the plan modal. */
  async clickExpand() {
    await this.page.getByTestId('plan-expand-button').first().click()
  }

  /** Opens the visible plan card explicitly, preserving the no-auto-open contract. */
  async openFromCard() {
    await this.waitForPlanCard()
    await this.clickExpand()
    await this.waitForModal()
  }

  /** Waits for the plan modal to be visible. */
  async waitForModal(timeout = 8_000) {
    await this.page.getByTestId('plan-modal').waitFor({ state: 'visible', timeout })
  }

  /** Returns whether the plan modal is currently visible. */
  async isModalVisible(): Promise<boolean> {
    return this.page.getByTestId('plan-modal').isVisible()
  }

  /** Closes the plan modal via the close button. */
  async closeModal() {
    await this.page.getByTestId('plan-modal-close').click()
  }

  /** Returns the header title text of the plan modal ("Review Plan"). */
  async getModalTitle(): Promise<string> {
    return (await this.page.locator('.doc-shell-title').textContent()) ?? ''
  }

  /** Returns whether the formatting toolbar is visible inside the modal. */
  async isToolbarVisible(): Promise<boolean> {
    return this.page.locator('.doc-shell-toolbar').isVisible()
  }

  /** Clicks the Link button in the plan modal toolbar. */
  async clickToolbarLink() {
    await this.page.locator('.doc-shell-toolbar').getByRole('button', { name: 'Link' }).click()
  }

  /** Returns whether the inline link popover is visible. */
  async isLinkPopoverVisible(): Promise<boolean> {
    return this.page.getByRole('textbox', { name: 'Link URL' }).isVisible()
  }

  /** Types a link URL into the popover and submits it with Enter. */
  async submitLink(url: string) {
    const input = this.page.getByRole('textbox', { name: 'Link URL' })
    await input.fill(url)
    await input.press('Enter')
  }

  /** Returns whether the action bar sleeve is visible at the bottom of the modal. */
  async isActionBarVisible(): Promise<boolean> {
    return this.page.locator('.plan-action-bar-sleeve').isVisible()
  }

  /** Returns whether the document editor region is visible. */
  async isEditorVisible(): Promise<boolean> {
    return this.page.locator('[aria-label="Plan document"]').isVisible()
  }

  // ─── Action bar interactions ───

  /** Types a comment into the plan action bar note input. */
  async typeComment(text: string) {
    const input = this.page.getByTestId('plan-action-comment')
    await input.click()
    await input.fill(text)
  }

  /** Clicks the Reject button in the action bar. */
  async clickReject() {
    await this.page.getByTestId('plan-action-reject').first().click()
  }

  /** Clicks the Revise button in the action bar. */
  async clickRevise() {
    await this.page.getByTestId('plan-action-revise').first().click()
  }

  /** Clicks the Yes (approve with ask mode) button in the action bar. */
  async clickYes() {
    await this.page.getByTestId('plan-action-yes').first().click()
  }

  /** Clicks the Yes Auto (approve with auto mode) button in the action bar. */
  async clickYesAuto() {
    await this.page.getByTestId('plan-action-yes-auto').first().click()
  }

  /** Returns whether the Revise button is disabled. */
  async isReviseDisabled(): Promise<boolean> {
    return this.page.getByTestId('plan-action-revise').first().isDisabled()
  }

  /** Clicks the worktree toggle button in the action bar. */
  async clickWorktreeToggle() {
    await this.page.getByTestId('plan-action-worktree').first().click()
  }

  /** Returns whether the worktree toggle is active (pressed). */
  async isWorktreeActive(): Promise<boolean> {
    const btn = this.page.getByTestId('plan-action-worktree').first()
    return (await btn.getAttribute('aria-pressed')) === 'true'
  }

  /** Returns whether the worktree toggle is visible. */
  async isWorktreeToggleVisible(): Promise<boolean> {
    return this.page.getByTestId('plan-action-worktree').isVisible()
  }

  /** Waits for a new user message to appear beyond the current count. */
  async waitForNewUserMessage(currentCount: number, timeout = 10_000) {
    await this.page.waitForFunction(
      ({ selector, expected }: { selector: string; expected: number }) =>
        document.querySelectorAll(selector).length > expected,
      { selector: `${ACTIVE_TAB} [data-testid="user-message"]`, expected: currentCount },
      { timeout },
    )
  }

  /** Returns the current number of user messages in the active conversation. */
  async getUserMessageCount(): Promise<number> {
    return this.page.locator(`${ACTIVE_TAB} [data-testid="user-message"]`).count()
  }
}
