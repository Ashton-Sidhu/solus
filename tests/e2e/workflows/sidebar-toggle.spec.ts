import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

test('the sidebar button closes and reopens the session list', async ({ page }) => {
  const app = new AppPage(page)
  await app.waitForAppReady()

  const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
  const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true })
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')
  await collapse.click()
  await expect(expand).toHaveAttribute('aria-expanded', 'false')
  await expand.click()
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')
})
