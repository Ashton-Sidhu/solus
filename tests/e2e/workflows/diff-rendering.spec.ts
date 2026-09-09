import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

test('diff panel is not visible by default when there are no changed files', async ({ page }) => {
  const app = new AppPage(page)
  await app.waitForAppReady()

  // The diff panel should never appear unless a session has changedFiles.
  await expect(page.locator('[data-testid="diff-panel"]')).not.toBeVisible()
})
