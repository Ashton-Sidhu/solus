import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'

// SessionSidebar is exclusive to editor mode — this test drives the editor shell.

test.describe('Sidebar task navigation', () => {
  test('expanding a task shows its sessions and clicking a session activates its tab', async ({
    page,
  }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('First session in task')
    await conversation.waitForResponse()
    await app.switchToEditorMode()

    // Cmd+T creates another draft under the active task.
    await page.keyboard.press('ControlOrMeta+t')
    await expect(async () => {
      expect(await app.getTabCount()).toBe(2)
    }).toPass({ timeout: 3000 })

    await conversation.typeAndSend('Second session in task')
    await conversation.waitForResponse()

    const taskRow = page
      .locator(`${ACTIVE_SHELL} [role="treeitem"][data-task-key]`)
      .filter({ hasText: 'First session in task' })
      .first()
    await expect(taskRow).toBeVisible({ timeout: 3000 })

    // Selecting a task with multiple sessions toggles its disclosure state.
    await taskRow.click()
    await expect(taskRow).toHaveAttribute('aria-expanded', 'true', { timeout: 3000 })

    const sessionRows = page.locator(
      `${ACTIVE_SHELL} [role="treeitem"][data-tab-id]`,
    )
    await expect(sessionRows).toHaveCount(2, { timeout: 3000 })

    const firstSession = sessionRows.first()
    const firstTabId = await firstSession.getAttribute('data-tab-id')
    expect(firstTabId).toBeTruthy()
    await firstSession.click()
    await expect(firstSession).toHaveAttribute('aria-selected', 'true', {
      timeout: 3000,
    })
  })
})
