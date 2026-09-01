import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

const DIALOG = '#open-project[role="dialog"]'
const TITLE = `${DIALOG} #open-project-title`
const OPTION = `${DIALOG} [role="option"]`
const PRIMARY = `${DIALOG} footer button:last-of-type`
const CHIP = `${DIALOG} header button[aria-label^="Run on"]`

// window.solus can't be mocked from the page, so the flow runs against the real
// local host. Assertions are on the *flow model* — which step is showing, what
// the two actions commit to — never on a specific repository or folder name.
async function openFlow(page: import('@playwright/test').Page) {
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('solus:open-project')),
  )
  await page.locator(DIALOG).waitFor({ state: 'visible', timeout: 5000 })
  await page.locator(OPTION).first().waitFor({ state: 'visible', timeout: 5000 })
}

/** Enters a step by clicking its home row, whatever index the recents push it to. */
async function chooseAction(page: import('@playwright/test').Page, label: string) {
  await page.locator(OPTION).filter({ hasText: label }).first().click()
}

test.describe('Open project flow', () => {
  test('opens on one screen with the machine already chosen, not on a question about it', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openFlow(page)

    await expect(page.locator(TITLE)).toHaveText('Open project')
    // Opening a folder and cloning are always offered; GitHub only when signed in.
    const labels = await page.locator(OPTION).allInnerTexts()
    expect(labels.some((text) => text.includes('Open a folder'))).toBe(true)
    expect(labels.some((text) => text.includes('Clone from a URL'))).toBe(true)

    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })

  test('one connected machine is not a choice, so nothing asks about it', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openFlow(page)

    // No machine step on the way in, and no chip to change an answer of one.
    await expect(page.locator(CHIP)).toBeHidden()

    await chooseAction(page, 'Clone from a URL')

    await expect(page.locator(TITLE)).toHaveText('Clone from a URL')
    await expect(page.locator(`${DIALOG} input[aria-label="Repository URL"]`)).toBeVisible()
    await expect(page.locator(CHIP)).toBeHidden()

    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })

  test('Escape steps back to home before it dismisses the flow', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openFlow(page)

    await chooseAction(page, 'Clone from a URL')
    await expect(page.locator(TITLE)).toHaveText('Clone from a URL')

    await page.keyboard.press('Escape')
    await expect(page.locator(TITLE)).toHaveText('Open project')
    await expect(page.locator(DIALOG)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })

  test('the primary action stays disabled until there is something to clone, then names the folder it lands in', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openFlow(page)
    await chooseAction(page, 'Clone from a URL')

    const primary = page.locator(PRIMARY)
    await expect(primary).toBeDisabled()

    await page.locator(`${DIALOG} input[aria-label="Repository URL"]`).fill('solus-sh/solus')

    await expect(primary).toBeEnabled()
    // The destination is spelled out in the footer and in the form's own hint —
    // the clone lands under the machine's projects root unless one is chosen.
    await expect(page.locator(`${DIALOG} footer`)).toContainText('/solus')
    await expect(page.locator(DIALOG)).toContainText('Clones onto')
    await expect(primary).toContainText('Clone')

    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })

  test('opening a folder hands off to the directory picker, and Escape returns home', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openFlow(page)

    await chooseAction(page, 'Open a folder')

    // The picker is the only folder UI; the flow steps aside while it owns
    // navigation and selection.
    await expect(page.locator('#directory-picker[role="dialog"]')).toBeVisible()
    await expect(page.locator(DIALOG)).toBeHidden()

    await page.keyboard.press('Escape')
    await expect(page.locator('#directory-picker[role="dialog"]')).toBeHidden()
    await expect(page.locator(DIALOG)).toBeVisible()
    await expect(page.locator(TITLE)).toHaveText('Open project')

    await page.keyboard.press('Escape')
  })

  test('the clone destination field reuses the directory picker and cancelling returns to the clone', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openFlow(page)
    await chooseAction(page, 'Clone from a URL')
    await page.locator(`${DIALOG} input[aria-label="Repository URL"]`).fill('solus-sh/solus')

    await page.locator(`${DIALOG} button`, { hasText: 'Choose…' }).click()

    // One dialog at a time: the flow steps aside rather than stacking.
    await expect(page.locator('#directory-picker[role="dialog"]')).toBeVisible()
    await expect(page.locator(DIALOG)).toBeHidden()

    await page.keyboard.press('Escape')

    // Cancelling a browse returns to the step it was started from, with the URL
    // that sent it there still in the box.
    await expect(page.locator('#directory-picker[role="dialog"]')).toBeHidden()
    await expect(page.locator(DIALOG)).toBeVisible()
    await expect(page.locator(TITLE)).toHaveText('Clone from a URL')
    await expect(page.locator(`${DIALOG} input[aria-label="Repository URL"]`)).toHaveValue('solus-sh/solus')

    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })
})
