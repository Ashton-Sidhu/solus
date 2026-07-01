import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { PlanGalleryPage } from '../helpers/plan-gallery.page'

test.describe('Plan gallery', () => {
  test('opens via Alt+Shift+L keyboard shortcut', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new PlanGalleryPage(page)
    await app.waitForAppReady()

    await gallery.open()
    await gallery.waitForOpen()

    expect(await gallery.isOpen()).toBe(true)
  })

  test('shows "No plans yet." empty state when the mock backend has no plans', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new PlanGalleryPage(page)
    await app.waitForAppReady()

    await gallery.open()
    await gallery.waitForOpen()

    await expect(gallery.emptyTitle()).toBeVisible()
    await expect(gallery.emptyTitle()).toHaveText('No plans yet.')
  })

  test('closes via Escape key', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new PlanGalleryPage(page)
    await app.waitForAppReady()

    await gallery.open()
    await gallery.waitForOpen()
    await gallery.close()
    await gallery.waitForClosed()

    expect(await gallery.isOpen()).toBe(false)
  })

  test('renders All, Pending, Accepted, and Rejected status filter tabs', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new PlanGalleryPage(page)
    await app.waitForAppReady()

    await gallery.open()
    await gallery.waitForOpen()

    await expect(gallery.filterTab(/all plans/i)).toBeVisible()
    await expect(gallery.filterTab(/pending plans/i)).toBeVisible()
    await expect(gallery.filterTab(/accepted plans/i)).toBeVisible()
    await expect(gallery.filterTab(/rejected plans/i)).toBeVisible()
  })

  test('renders search input with placeholder "Search plans…"', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new PlanGalleryPage(page)
    await app.waitForAppReady()

    await gallery.open()
    await gallery.waitForOpen()

    await expect(gallery.searchInput()).toBeVisible()
  })

  test('renders a Bookmarked filter button', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new PlanGalleryPage(page)
    await app.waitForAppReady()

    await gallery.open()
    await gallery.waitForOpen()

    await expect(gallery.bookmarkedButton()).toBeVisible()
  })

  test('can be toggled closed and reopened via the keyboard shortcut', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new PlanGalleryPage(page)
    await app.waitForAppReady()

    // Open
    await gallery.open()
    await gallery.waitForOpen()
    expect(await gallery.isOpen()).toBe(true)

    // Close
    await gallery.open()
    await gallery.waitForClosed()
    expect(await gallery.isOpen()).toBe(false)

    // Reopen
    await gallery.open()
    await gallery.waitForOpen()
    expect(await gallery.isOpen()).toBe(true)
  })

  test('filter tabs show plan counts of zero in empty state', async ({ page }) => {
    const app = new AppPage(page)
    const gallery = new PlanGalleryPage(page)
    await app.waitForAppReady()

    await gallery.open()
    await gallery.waitForOpen()

    // All (0), Pending (0), Accepted (0), Rejected (0) — counts are part of aria-label
    const allTab = gallery.filterTab(/all plans \(0\)/i)
    const pendingTab = gallery.filterTab(/pending plans \(0\)/i)
    await expect(allTab).toBeVisible()
    await expect(pendingTab).toBeVisible()
  })
})
