import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

test.describe('Editor tab bar chrome', () => {
  test('tab bar is flush (no pill margin) in editor mode', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    // The editor variant bar should have no rounded-pill margin/border-radius —
    // it must extend flush to the window edges.
    const tabBarRow = page.locator('.editor-shell .editor-variant .tab-bar-row')
    await expect(tabBarRow).toBeVisible()

    const margin = await tabBarRow.evaluate((el) => {
      const s = getComputedStyle(el)
      return {
        marginLeft: s.marginLeft,
        marginRight: s.marginRight,
        borderRadius: s.borderRadius,
      }
    })

    expect(margin.marginLeft).toBe('0px')
    expect(margin.marginRight).toBe('0px')
    expect(margin.borderRadius).toBe('0px')
  })

  test('sidebar expand toggle appears in bar when sidebar is collapsed', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    // Initially sidebar is open — no in-bar expand toggle
    await expect(page.locator('.editor-shell .tab-chrome-lead[aria-label="Expand sidebar"]')).not.toBeVisible()

    // Collapse the sidebar
    await page.keyboard.press('ControlOrMeta+b')

    // The expand toggle should now appear in the tab bar
    const expandBtn = page.locator('.editor-shell .tab-chrome-lead[aria-label="Expand sidebar"]')
    await expect(expandBtn).toBeVisible()
  })

  test('sidebar expand toggle re-expands sidebar and disappears', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    // Collapse
    await page.keyboard.press('ControlOrMeta+b')
    const expandBtn = page.locator('.editor-shell .tab-chrome-lead[aria-label="Expand sidebar"]')
    await expect(expandBtn).toBeVisible()

    // Click expand
    await expandBtn.click()

    // Toggle should be gone again (sidebar is open)
    await expect(expandBtn).not.toBeVisible()
  })

  test('tab bar has a bottom hairline seam separating chrome from canvas', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    const tabBarRow = page.locator('.editor-shell .editor-variant .tab-bar-row')
    const borderBottom = await tabBarRow.evaluate((el) =>
      getComputedStyle(el).borderBottomWidth
    )
    // 1px seam must be present
    expect(borderBottom).toBe('1px')
  })
})

test.describe('Full-page frame chrome', () => {
  // The tab strip only makes sense over a conversation. On full-page views
  // (settings / galleries / documents) it is swapped for a slim drag strip, and
  // the frame-level expand controls live INLINE in each page's own header
  // (FrameExpandButton) rather than in a separate floating row.
  test('tab bar is swapped for the slim drag strip on the settings page', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    // Conversation view: tab bar present, drag strip absent.
    await expect(page.locator('.editor-shell .editor-variant .tab-bar-row')).toBeVisible()
    await expect(page.locator('.editor-shell .page-drag-strip')).not.toBeVisible()

    // Open settings — a full-page view.
    await page.keyboard.press('ControlOrMeta+Comma')

    // The tab strip is swapped for the slim drag strip.
    await expect(page.locator('.editor-shell .page-drag-strip')).toBeVisible()
    await expect(page.locator('.editor-shell .editor-variant .tab-bar-row')).not.toBeVisible()
  })

  test('sidebar expand control lives inline in the page header and re-expands', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()
    await page.keyboard.press('ControlOrMeta+Comma')

    // The control sits inside the settings page's own <header>, not a separate
    // chrome row — confirming it is hosted inline.
    const expandBtn = page.locator(
      '.editor-shell header .frame-expand-btn[aria-label="Expand sidebar"]',
    )

    // Sidebar starts open → no inline expand control.
    await expect(expandBtn).not.toBeVisible()

    // Collapse the sidebar → the control appears inline in the header.
    await page.keyboard.press('ControlOrMeta+b')
    await expect(expandBtn).toBeVisible()

    // It re-expands the sidebar and disappears.
    await expandBtn.click()
    await expect(expandBtn).not.toBeVisible()
  })

  test('drag strip also stands in for the tab bar on the plans gallery', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await app.switchToEditorMode()

    await page.keyboard.press('Alt+Shift+KeyL')

    await expect(page.locator('.editor-shell .page-drag-strip')).toBeVisible()
    await expect(page.locator('.editor-shell .editor-variant .tab-bar-row')).not.toBeVisible()
  })
})
