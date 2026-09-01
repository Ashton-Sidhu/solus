import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

// Mock keyword that makes the backend emit a multi-line assistant message we can
// select text from. (Same trigger streaming-text.spec relies on.)
const ASSISTANT_PROMPT = 'MOCKMARKDOWN'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`
const ASSISTANT_MSG = `${ACTIVE_TAB} [data-testid="assistant-message"]`
const MESSAGE_INPUT = `${ACTIVE_SHELL} [data-testid="message-input"]`

// `window.solus` is a frozen contextBridge object, so we can't spy on it from the
// page. Instead, observe the real setQuoteContext IPC on the main side (an extra
// ipcMain listener) — this asserts the actual cross-process contract.
async function spyQuoteContext(electronApp: import('@playwright/test').ElectronApplication) {
  await electronApp.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __quoteCalls: boolean[] }
    g.__quoteCalls = []
    ipcMain.on('solus:set-quote-context', (_e, active: boolean) => g.__quoteCalls.push(active))
  })
}

function lastQuoteCall(electronApp: import('@playwright/test').ElectronApplication) {
  return electronApp.evaluate(() => {
    const calls = (globalThis as unknown as { __quoteCalls: boolean[] }).__quoteCalls
    return calls && calls.length ? calls[calls.length - 1] : null
  })
}

async function selectContents(page: import('@playwright/test').Page, selector: string) {
  await page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].pop()
    if (!el) throw new Error(`no element for ${sel}`)
    const range = document.createRange()
    range.selectNodeContents(el)
    const s = window.getSelection()!
    s.removeAllRanges()
    s.addRange(range)
  }, selector)
}

test.describe('Quote in reply', () => {
  test('selection is marked quotable only inside the conversation view', async ({ page, electronApp }) => {
    // WHY: "Quote in reply" must appear for conversation output but not for the
    // composer or other selectable surfaces. The renderer-side gate is what
    // decides that, so it must flip true/false with where the selection lives.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend(ASSISTANT_PROMPT)
    await conversation.waitForResponse()

    await spyQuoteContext(electronApp)

    // Selecting assistant output → quotable.
    await selectContents(page, ASSISTANT_MSG)
    await expect.poll(() => lastQuoteCall(electronApp)).toBe(true)

    // Selecting text in the composer (editable, outside the conversation) → not quotable.
    const input = page.locator(MESSAGE_INPUT)
    await input.click()
    await input.pressSequentially('draft text')
    await selectContents(page, MESSAGE_INPUT)
    await expect.poll(() => lastQuoteCall(electronApp)).toBe(false)
  })

  test('picking "Quote in reply" inserts the snippet as a blockquote in the composer', async ({ page, electronApp }) => {
    // WHY: the whole point is to pull a specific bit of agent output into the
    // composer so the user can address it. The selected text must land as a
    // markdown blockquote and the input must regain focus to keep typing.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend(ASSISTANT_PROMPT)
    await conversation.waitForResponse()

    // Simulate the user choosing "Quote in reply" from the native menu: main
    // sends the selected text to the renderer over the same channel.
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('solus:quote-selection', 'specific claim')
    })

    const quote = page.locator(`${MESSAGE_INPUT} blockquote`)
    await expect(quote).toHaveText(/specific claim/, { timeout: 5_000 })

    // Composer is focused so the user can immediately type their reply.
    await expect.poll(() =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel)
        return !!el && (el === document.activeElement || el.contains(document.activeElement))
      }, MESSAGE_INPUT),
    ).toBe(true)

    await page.keyboard.type('my response')
    await expect(quote).toHaveText(/specific claim/)
    await expect(page.locator(`${MESSAGE_INPUT} blockquote >> text=my response`)).toHaveCount(0)
    await expect(page.locator(`${MESSAGE_INPUT} p`).last()).toHaveText('my response')
  })
})
