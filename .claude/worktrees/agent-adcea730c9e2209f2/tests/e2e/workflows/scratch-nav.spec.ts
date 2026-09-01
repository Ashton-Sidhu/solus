import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const INPUT_EDITOR = `${ACTIVE_SHELL} [data-testid="message-input"] .solus-md-editor`

test('new list: down works immediately (no settle wait)', async ({ page }) => {
  const app = new AppPage(page)
  await app.waitForAppReady()
  const input = page.locator(INPUT_EDITOR)
  await input.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('@sol')
  await expect(page.locator('.file-menu-list')).toBeVisible({ timeout: 5000 })
  const rows = page.locator('.file-menu-row')
  const sel = async () => {
    const count = await rows.count()
    for (let i = 0; i < count; i++)
      if ((await rows.nth(i).getAttribute('class'))?.includes('selected')) return i
    return -1
  }
  const seq: number[] = []
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowDown')
    seq.push(await sel())
  }
  console.log('NEW-IMMEDIATE-SEQ:', JSON.stringify(seq))
})
