import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const INPUT_EDITOR = `${ACTIVE_SHELL} [data-testid="message-input"] .solus-md-editor`

async function replaceInput(page: import('@playwright/test').Page, text: string) {
  const input = page.locator(INPUT_EDITOR)
  await input.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(text)
}

// Each menu gets its own test so one menu regression doesn't mask the others.
// window.solus is exposed via contextBridge and is read-only from the page,
// so these tests run against the real backend rather than mocked responses.
test.describe('Input autocomplete menus', () => {
  // The plan menu only shows when plan descriptors exist for the working
  // directory, and the contextBridge API can't be mocked from the page.
  // Needs a fixture that seeds a real plan file before this can assert.
  test.fixme('# opens the plan menu', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await replaceInput(page, '#')
    await expect(page.locator('.plan-menu-list')).toBeVisible({ timeout: 5000 })
  })

  test('/ opens the command menu', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await replaceInput(page, '/')
    await expect(page.locator('.slash-menu-list')).toBeVisible()
    await expect(page.locator('.slash-menu-list')).toContainText('/clear')
  })

  test('@ opens the file menu with results', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await replaceInput(page, '@')
    await expect(page.locator('.file-menu-list')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.file-menu-row').first()).toBeVisible()
  })

  test('@ menu arrows move selection to the adjacent row', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await replaceInput(page, '@')
    const items = page.locator('.file-menu-row')
    await expect(items.first()).toBeVisible({ timeout: 5000 })

    const selectedIndex = async () => {
      const count = await items.count()
      for (let i = 0; i < count; i++) {
        if ((await items.nth(i).getAttribute('aria-selected')) === 'true') return i
      }
      return -1
    }

    const before = await selectedIndex()
    expect(before).toBeGreaterThanOrEqual(0)
    await page.keyboard.press('ArrowDown')
    const after = await selectedIndex()
    const count = await items.count()
    // Down moves to the next row (wrapping from the last to the first).
    expect(after).toBe(before === count - 1 ? 0 : before + 1)
  })

  test('@ menu shows ranked results for a fuzzy search with selection on the best match', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    // A non-empty query goes through searchFiles (fuzzy ranked) — a different
    // code path than the flat directory listing the plain-@ tests cover.
    await replaceInput(page, '@sol')
    await expect(page.locator('.file-menu-list')).toBeVisible({ timeout: 5000 })
    const items = page.locator('.file-menu-row')
    await expect(items.first()).toBeVisible({ timeout: 5000 })

    // Let the debounced search settle: new results must snap selection back
    // to the first (best-ranked) row so Enter accepts the best match.
    await page.waitForTimeout(300)
    await expect(items.first()).toHaveAttribute('aria-selected', 'true')
  })

  test('@ menu keyboard flow: arrow to a result and Enter inserts a file chip', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await replaceInput(page, '@')
    await expect(page.locator('.file-menu-row').first()).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.locator('.file-menu-list')).not.toBeVisible()
    await expect(page.locator(`${INPUT_EDITOR} span[data-file-ref]`)).toBeVisible()
  })
})
