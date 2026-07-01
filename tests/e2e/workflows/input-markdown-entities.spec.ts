import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`
const INPUT_EDITOR = `${ACTIVE_SHELL} [data-testid="message-input"] .solus-md-editor`
const USER_MESSAGE = `${ACTIVE_TAB} [data-testid="user-message"]`

async function typeAndSend(page: import('@playwright/test').Page, text: string) {
  const input = page.locator(INPUT_EDITOR)
  await input.click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test.describe('Input markdown entity serialization', () => {
  test('does not carry inline code styling past the closing backtick', async ({ page }) => {
    // WHY: closing a typed inline-code span used to leave Tiptap's stored code
    // mark active, so following prose rendered with the code colour.
    const app = new AppPage(page)
    await app.waitForAppReady()

    const input = page.locator(INPUT_EDITOR)
    await input.click()
    await page.keyboard.type('`code` rest')

    await expect(input.locator('code')).toHaveCount(1)
    await expect(input.locator('code')).toHaveText('code')
    await expect(input).toHaveText('code rest')
  })

  test('keeps literal entities inside inline code when sending', async ({ page }) => {
    // WHY: users paste entity examples into code spans; serialization must not
    // turn the literal `&lt;` text into a real less-than character.
    const app = new AppPage(page)
    await app.waitForAppReady()

    await typeAndSend(page, '`a &lt; b`')

    const message = page.locator(USER_MESSAGE).first()
    await expect(message.locator('code')).toHaveText('a &lt; b')
  })

  test('still unescapes prose entities created by the markdown serializer', async ({ page }) => {
    // WHY: the prose unescape preserves the existing visible-text behavior for
    // normal messages containing angle brackets.
    const app = new AppPage(page)
    await app.waitForAppReady()

    await typeAndSend(page, 'a < b')

    await expect(page.locator(USER_MESSAGE).first()).toContainText('a < b')
  })
})
