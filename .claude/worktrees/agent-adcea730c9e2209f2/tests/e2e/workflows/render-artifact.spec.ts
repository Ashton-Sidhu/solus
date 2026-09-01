import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

test.describe('render_artifact workflow', () => {
  test('html artifact renders a sandboxed iframe flush in the conversation', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_ARTIFACT_HTML__ show me an interactive widget')

    const frame = page.locator(`${ACTIVE_TAB} [data-testid="artifact-iframe"]`)
    await expect(frame).toBeVisible({ timeout: 10_000 })

    // Sandboxed with scripts only — never same-origin (the security invariant).
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')

    // The agent-authored markup actually rendered inside the frame.
    const inner = page.frameLocator(`${ACTIVE_TAB} [data-testid="artifact-iframe"]`)
    await expect(inner.locator('[data-testid="artifact-input"]')).toBeVisible({ timeout: 5_000 })
  })

  test('raster image artifact renders via the solus-artifact protocol', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_ARTIFACT_IMAGE__ render an existing image')

    const img = page.locator(`${ACTIVE_TAB} [data-testid="artifact-image"]`)
    await expect(img).toBeVisible({ timeout: 10_000 })
    await expect(img).toHaveAttribute('src', /^solus-artifact:\/\//)

    // The protocol served real bytes — the image decoded to non-zero dimensions.
    await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)

    await page.locator(`${ACTIVE_TAB} [data-testid="artifact-view"]`).hover()
    await expect(page.locator(`${ACTIVE_TAB} [data-testid="artifact-copy-image"]`)).toBeVisible()
    await expect(page.locator(`${ACTIVE_TAB} [data-testid="artifact-download-image"]`)).toHaveCount(0)
  })

  test('expand toggles fullscreen without reloading the iframe (state persists)', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_ARTIFACT_HTML__ show me an interactive widget')

    const view = page.locator(`${ACTIVE_TAB} [data-testid="artifact-view"]`)
    await expect(view).toBeVisible({ timeout: 10_000 })

    // Set a value INSIDE the sandboxed iframe.
    const inner = page.frameLocator(`${ACTIVE_TAB} [data-testid="artifact-iframe"]`)
    const input = inner.locator('[data-testid="artifact-input"]')
    await input.fill('42')
    await expect(input).toHaveValue('42')

    // Expand → the frame is promoted via CSS, not re-mounted/moved.
    await view.hover()
    await page.locator(`${ACTIVE_TAB} [data-testid="artifact-expand"]`).click()
    await expect(view).toHaveClass(/expanded/)

    // Same iframe node, so the in-frame value survives the expand (no reload).
    await expect(input).toHaveValue('42')
  })
})
