import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`
const INPUT_EDITOR = `${ACTIVE_SHELL} [data-testid="message-input"] .cm-content`
const USER_MESSAGE = `${ACTIVE_TAB} [data-testid="user-message"]`

async function typeAndSend(page: import('@playwright/test').Page, text: string) {
  const input = page.locator(INPUT_EDITOR)
  await input.click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test.describe('Input markdown entity serialization', () => {
  test('keeps inline-code markdown and following prose as literal text', async ({ page }) => {
    // WHY: the prompt editor is source-first; typing after a closing backtick
    // must append plain text without any hidden rich-text mark state.
    const app = new AppPage(page)
    await app.waitForAppReady()

    const input = page.locator(INPUT_EDITOR)
    await input.click()
    await page.keyboard.type('`code` rest')

    await expect(input.locator('code')).toHaveCount(0)
    await expect(input).toHaveText('`code` rest')
  })

  test('keeps the space before typed inline-code markdown', async ({ page }) => {
    // WHY: source editing must preserve every typed character exactly,
    // especially the word-separating space before an opening backtick.
    const app = new AppPage(page)
    await app.waitForAppReady()

    const input = page.locator(INPUT_EDITOR)
    await input.click()
    await page.keyboard.type('before `code`')

    await expect(input).toHaveText('before `code`')
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

  test('preserves literal angle brackets in prose', async ({ page }) => {
    // WHY: CodeMirror emits source text directly, without a rich-text
    // serializer that can entity-encode ordinary prose.
    const app = new AppPage(page)
    await app.waitForAppReady()

    await typeAndSend(page, 'a < b')

    await expect(page.locator(USER_MESSAGE).first()).toContainText('a < b')
  })
})
