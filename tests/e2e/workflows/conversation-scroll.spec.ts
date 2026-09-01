import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`
const CONVERSATION_SCROLL = `${ACTIVE_TAB} .conversation-selectable`

test.describe('Conversation scrolling', () => {
  test('sending a message returns a scrolled-up conversation to the bottom', async ({ page }) => {
    // WHY: a locally sent message starts a new turn, so it must remain visible even
    // when the reader had previously scrolled up to inspect older conversation.
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('First message')
    await conversation.waitForResponse()

    const scroll = page.locator(CONVERSATION_SCROLL)
    await scroll.evaluate((el) => {
      const content = el.firstElementChild as HTMLElement | null
      if (content) content.style.paddingTop = '2000px'
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(0)

    await conversation.typeAndSend('Second message')

    await expect.poll(() => scroll.evaluate((el) =>
      Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
    )).toBeLessThanOrEqual(1)
  })
})
