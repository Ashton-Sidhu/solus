import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.workspace-shell'

test.describe('Error handling workflow', () => {
  test('send stays disabled for a blank draft', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    const send = page.locator(ACTIVE_SHELL).getByRole('button', { name: 'Send message' })
    await expect(send).toBeDisabled()
    await conversation.typeMessage(' ')
    await expect(send).toBeDisabled()
    await conversation.typeMessage('Ready')
    await expect(send).toBeEnabled()
  })
})
