import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

const DIALOG = '#directory-picker[role="dialog"]'
const PATH_INPUT = `${DIALOG} input[aria-label="Folder path"]`
const CRUMB = `${DIALOG} nav[aria-label="Path breadcrumbs"] button`
const OPTION = `${DIALOG} [role="option"]`

// window.solus can't be mocked from the page, so the picker runs against the
// real filesystem rooted at the test working directory. We assert on the
// navigation *model* (what the crumbs point at, what typing lists, what Enter
// does) rather than on specific folder names, and close with Escape so nothing
// is committed.
async function openPicker(page: import('@playwright/test').Page) {
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('solus:open-directory-picker')),
  )
  await page.locator(DIALOG).waitFor({ state: 'visible', timeout: 5000 })
  await page.locator(OPTION).first().waitFor({ state: 'visible', timeout: 5000 })
}

/** The trail carries the directory being listed; each crumb's title is its path. */
function currentDirectory(page: import('@playwright/test').Page) {
  return page.locator(CRUMB).last().getAttribute('title')
}

/** Descends into the first real folder, ignoring metadata rendered under its name. */
async function descendIntoFirstFolder(page: import('@playwright/test').Page) {
  await page.keyboard.press('ArrowDown')
  const selected = page.locator(`${OPTION}[aria-selected="true"]`)
  await expect(selected).toHaveCount(1)
  if ((await selected.innerText()).trim() === '..') {
    await page.keyboard.press('ArrowDown')
  }
  const folderName = (await selected.innerText()).trim().split('\n')[0]
  await page.keyboard.press('Enter')
  await expect(page.locator(CRUMB).last()).toHaveText(folderName)
  return folderName
}

test.describe('Directory picker typed-path UX', () => {
  test('the trail holds the folder and the input holds only what is typed inside it', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openPicker(page)

    // A trailing separator is what makes the picker list the folder's contents
    // instead of filtering its parent by the folder's own name.
    expect(await currentDirectory(page)).toMatch(/\/$/)
    // Nothing is being filtered yet, so the typing half of the field is empty.
    await expect(page.locator(PATH_INPUT)).toHaveValue('')

    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })

  test('typing a leaf name filters the list by prefix without leaving the folder', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openPicker(page)

    const directory = await currentDirectory(page)
    const firstName = (await page.locator(OPTION).allInnerTexts())
      .map((name) => name.trim().split('\n')[0])
      .find((name) => name !== '..')
    if (!firstName) throw new Error('Expected at least one folder to filter')
    const prefix = firstName.slice(0, 2)
    await page.locator(PATH_INPUT).fill(prefix)
    await expect(page.locator(OPTION).first()).toBeVisible()

    // Every remaining row must start with what was typed — prefix, not substring.
    const names = await page.locator(OPTION).allInnerTexts()
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(name.trim().toLowerCase().startsWith(prefix.toLowerCase())).toBe(true)
    }
    // A partial name is a filter, not a place: the trail must not have moved.
    expect(await currentDirectory(page)).toBe(directory)

    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })

  test('a pasted absolute path replaces the trail instead of extending it', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openPicker(page)

    await page.locator(PATH_INPUT).fill('/')

    // Typing a rooted path anywhere in the field re-anchors the picker, so the
    // trail collapses to the root rather than nesting it under the old folder.
    await expect(page.locator(CRUMB)).toHaveCount(1)
    expect(await currentDirectory(page)).toBe('/')

    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })

  test('Enter on a highlighted row descends, and the trail follows it', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openPicker(page)

    const folderName = await descendIntoFirstFolder(page)

    // Descending must land on the next directory boundary — that is what lets
    // the next keystroke filter inside the folder just entered.
    expect((await currentDirectory(page))?.endsWith(`${folderName}/`)).toBe(true)

    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })

  test('Backspace at a boundary walks up a level', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openPicker(page)

    await descendIntoFirstFolder(page)
    const before = await page.locator(CRUMB).count()
    await page.keyboard.press('Backspace')

    // A whole segment goes, not a single character — the path is a tree
    // position here, not free text.
    await expect(page.locator(CRUMB)).toHaveCount(before - 1)
    expect(await currentDirectory(page)).toMatch(/\/$/)

    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })

  test('clicking a crumb jumps back to that folder', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openPicker(page)

    await descendIntoFirstFolder(page)
    const crumbs = page.locator(CRUMB)
    const depth = await crumbs.count()
    const target = await crumbs.nth(depth - 2).getAttribute('title')
    await crumbs.nth(depth - 2).click()

    await expect(crumbs).toHaveCount(depth - 1)
    expect(await currentDirectory(page)).toBe(target)

    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })

  test('Home is not an artificial root of the host filesystem', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openPicker(page)

    const places = page.locator(`${DIALOG} nav[aria-label="Places"]`)
    await places.getByRole('button', { name: 'Home', exact: true }).click()
    await expect(page.locator(CRUMB).last()).toHaveAttribute('title', '~/')
    await expect(page.locator(DIALOG)).toContainText(/\d+ folders/)

    // `~` stays unexpanded in the field so it resolves on the browsed host.
    // Walking up must nevertheless use that host's resolved parent rather than
    // treating the alias as the top of the filesystem.
    await page.keyboard.press('Backspace')
    await expect(page.locator(CRUMB).last()).not.toHaveAttribute('title', '~/')

    // A direct root affordance matters on remote hosts where there is no native
    // OS dialog or shell shortcut to recover from an unfamiliar starting path.
    await places.getByRole('button', { name: 'Root', exact: true }).click()
    await expect(page.locator(CRUMB).last()).toHaveAttribute('title', '/')

    await page.keyboard.press('Escape')
    await expect(page.locator(DIALOG)).toBeHidden()
  })
})
