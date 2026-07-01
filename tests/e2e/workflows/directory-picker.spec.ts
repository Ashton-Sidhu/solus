import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

const DIALOG = '[role="dialog"][aria-label="Directory picker"]'
const OPTION = `${DIALOG} [role="option"]`
const SELECT_BTN = `${DIALOG} .select-btn`

// window.solus can't be mocked from the page, so the picker runs against the
// real filesystem rooted at the test working directory. We only assert on the
// keyboard *model* (what gets highlighted / what the primary action targets),
// never on specific folder names, and we close with Escape so the working
// directory is never actually changed.
async function openPicker(page: import('@playwright/test').Page) {
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('solus:open-directory-picker')),
  )
  await page.locator(DIALOG).waitFor({ state: 'visible', timeout: 5000 })
  // Wait until the folder list has loaded at least one entry.
  await page.locator(OPTION).first().waitFor({ state: 'visible', timeout: 5000 })
}

test.describe('Directory picker keyboard UX', () => {
  test('footer teaches Enter = select (not just ⌘↵)', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openPicker(page)

    // The whole point of the redesign: plain Enter selects. The hint must say so.
    await expect(page.locator(`${DIALOG} .footer-hints`)).toContainText('select')
    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })

  test('the primary action targets the highlighted folder', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openPicker(page)

    // Arrow down to highlight a child folder.
    await page.keyboard.press('ArrowDown')

    const selected = page.locator(`${OPTION}[aria-selected="true"]`)
    await expect(selected).toHaveCount(1)
    const highlightedName = (await selected.innerText()).trim()

    // The Select button must name exactly what Enter/click would pick — proving
    // the highlight and the primary action point at the same folder.
    await expect(page.locator(SELECT_BTN)).toContainText(highlightedName)

    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })

  test('ArrowDown then ArrowUp moves the highlight back', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openPicker(page)

    const firstName = (await page.locator(OPTION).first().innerText()).trim()

    await page.keyboard.press('ArrowDown')
    await expect(page.locator(`${OPTION}[aria-selected="true"]`)).not.toHaveText(
      firstName,
    )

    await page.keyboard.press('ArrowUp')
    await expect(page.locator(`${OPTION}[aria-selected="true"]`)).toHaveText(
      firstName,
    )

    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })
})
