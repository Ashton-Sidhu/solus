import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { sep } from 'node:path'

const ACTIVE_SHELL = '.workspace-shell'
const INPUT_EDITOR = `${ACTIVE_SHELL} [data-testid="message-input"] .cm-content`

async function replaceInput(page: import('@playwright/test').Page, text: string) {
  const input = page.locator(INPUT_EDITOR)
  await input.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(text)
}

test.describe('Input autocomplete menus', () => {
  test('/ opens the command menu', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await replaceInput(page, '/')
    const menu = page.getByRole('listbox')
    await expect(menu.getByRole('option').filter({ hasText: '/clear' })).toBeVisible()
  })

  test('@ menu keyboard flow: arrow to a result and Enter inserts a file chip', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await replaceInput(page, `@${__dirname}${sep}`)

    const menu = page.getByRole('listbox')
    const items = menu.getByRole('option')
    await expect(items.first()).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(page.locator(`${INPUT_EDITOR} [data-reference-kind="file"]`)).toBeVisible()
  })
})
