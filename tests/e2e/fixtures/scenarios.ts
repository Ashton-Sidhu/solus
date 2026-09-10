import { expect, type Page } from '@playwright/test'
import { worktreeProjectRoot } from '@solus/contracts/types'

/** Visual review data, created through the product. These are not behavioral assertions. */
export const visualScenarios = ['populated-conversation', 'permission-waiting', 'busy-session', 'provider-error', 'many-tasks'] as const
export type VisualScenario = typeof visualScenarios[number]

export async function populateVisualScenario(page: Page, scenario: VisualScenario, projectPath?: string): Promise<void> {
  if (scenario === 'many-tasks') {
    if (!projectPath) throw new Error('many-tasks requires the disposable project path')
    // Match the task page’s canonical project identity for managed worktrees.
    // This key is metadata on the isolated host; execution stays in projectPath.
    await page.evaluate(async (projectKey) => {
      const existing = await window.solus.tasksList({ projectKey })
      const statuses = ['todo', 'in_progress', 'in_review', 'done'] as const
      for (let index = 0; index < 20; index++) {
        const title = `QA fixture task ${String(index + 1).padStart(2, '0')}`
        if (existing.tasks.some((task) => task.title === title)) continue
        await window.solus.tasksCreate({ title, projectKey, status: statuses[index % statuses.length], body: 'Disposable visual fixture.', labels: ['qa-fixture'] })
      }
    }, worktreeProjectRoot(projectPath))
    await page.getByRole('button', { name: /^Tasks / }).click()
    // Board columns include completed tasks; the default list filters them out.
    await page.getByRole('button', { name: 'Board layout', exact: true }).click()
    await expect(page.getByText(/^QA fixture task \d{2}$/)).toHaveCount(20)
    await expect(page.getByText('QA fixture task 01', { exact: true }).first()).toBeVisible()
    return
  }
  const editor = page.locator('[data-testid="message-input"]:visible').first()
  const prompts = scenario === 'permission-waiting'
    ? ['Review command __MOCK_PERMISSION__']
    : scenario === 'provider-error' ? ['Review failure __MOCK_ERROR__']
    : scenario === 'busy-session' ? ['Review in progress __MOCK_HOLD__']
    : ['Explain the fixture', 'Show styled content MOCKMARKDOWN', 'Describe the next step']
  for (const prompt of prompts) {
    const responseCount = await page.locator('[data-testid="assistant-message"]:visible').count()
    await editor.getByRole('textbox').click()
    await page.keyboard.type(prompt)
    await page.keyboard.press('Enter')
    if (scenario === 'permission-waiting') {
      await expect(page.locator('[data-testid="permission-card"]:visible')).toBeVisible()
    } else if (scenario === 'busy-session') {
      // A held turn has no completed assistant message yet. Its Stop control
      // identifies the active run without waiting for completion.
      await expect(page.getByRole('button', { name: /^Stop/ }).first()).toBeVisible()
    } else if (scenario === 'provider-error') {
      await expect(page.getByText('QA fixture provider failure', { exact: false }).first()).toBeVisible()
    } else {
      await expect(page.locator('[data-testid="assistant-message"]:visible')).toHaveCount(responseCount + 1)
      await expect(page.locator('[data-testid="assistant-message"]:visible').last()).not.toBeEmpty()
    }
  }
}
