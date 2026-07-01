import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const MESSAGE_INPUT = `${ACTIVE_SHELL} [data-testid="message-input"]`

async function expectMessageInputFocused(page: import('@playwright/test').Page) {
  await expect(async () => {
    const focused = await page.evaluate((selector) => {
      const input = document.querySelector(selector)
      const active = document.activeElement
      return !!input && !!active && input.contains(active)
    }, MESSAGE_INPUT)
    expect(focused).toBe(true)
  }).toPass({ timeout: 3000 })
}

async function expectMessageInputNotFocused(page: import('@playwright/test').Page) {
  const focused = await page.evaluate((selector) => {
    const input = document.querySelector(selector)
    const active = document.activeElement
    return !!input && !!active && input.contains(active)
  }, MESSAGE_INPUT)
  expect(focused).toBe(false)
}

test.describe('Input focus behavior', () => {
  test('message input is reachable by accessible name', async ({ page }) => {
    // WHY: the primary composer must be discoverable to screen readers by
    // role and name, independent of the visual placeholder layer.
    const app = new AppPage(page)
    await app.waitForAppReady()

    const messageInput = page.locator(MESSAGE_INPUT)
    await expect(messageInput.getByRole('textbox', { name: /message/i })).toBeVisible()
  })

  test('focus request places the caret at the end of an existing draft', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    const editor = page.locator(`${MESSAGE_INPUT} .solus-md-editor`)
    await editor.click()
    await page.keyboard.type('existing draft')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('solus:focus-input')))
    await expectMessageInputFocused(page)
    await page.keyboard.type('!')

    await expect(editor).toHaveText('existing draft!')
  })

  test('focus returns to the input after tab actions but not after background session picker open', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await expectMessageInputFocused(page)

    await app.openNewTab()
    await expectMessageInputFocused(page)

    await app.openNewTab()
    await expectMessageInputFocused(page)

    await app.switchToTab(0)
    await expectMessageInputFocused(page)

    await page.evaluate(() => {
      const w = window as Window & {
        solus?: {
          listSessions?: (...args: unknown[]) => Promise<unknown>
          loadSession?: (...args: unknown[]) => Promise<unknown>
          worktreeRestore?: (...args: unknown[]) => Promise<unknown>
        }
      }
      if (!w.solus) return

      w.solus.listSessions = async () => [
        {
          provider: 'claude-code',
          sessionId: 'mock-history-session',
          slug: 'mock-history-session',
          firstMessage: 'Background history focus check',
          lastTimestamp: new Date().toISOString(),
          size: 1,
          cwd: '~',
          projectPath: '~',
          status: 'completed',
        },
      ]
      w.solus.loadSession = async () => [
        {
          role: 'user',
          content: 'Background history focus check',
          timestamp: Date.now(),
        },
        {
          role: 'assistant',
          content: 'Loaded in the background.',
          timestamp: Date.now(),
        },
      ]
      w.solus.worktreeRestore = async () => null
    })

    await page.keyboard.press('ControlOrMeta+p')
    await expect(page.getByRole('dialog', { name: 'Session picker' })).toBeVisible()
    await expect(page.getByPlaceholder(/Search .* sessions/)).toBeFocused()

    await page.keyboard.type('Background history')
    const tabCountBeforeBackgroundOpen = await app.getTabCount()
    await page.keyboard.press('Alt+Enter')

    await expect(page.getByRole('dialog', { name: 'Session picker' })).toBeVisible()
    await expect(page.getByPlaceholder(/Search .* sessions/)).toBeFocused()
    await expectMessageInputNotFocused(page)
    await expect(async () => {
      // WHY: "open in background" must create a visible background tab, even
      // when the active tab is blank and normal resume would reuse it.
      expect(await app.getTabCount()).toBe(tabCountBeforeBackgroundOpen + 1)
    }).toPass({ timeout: 3000 })
  })
})
