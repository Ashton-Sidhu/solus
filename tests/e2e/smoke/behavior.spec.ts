import { test, expect } from '../fixtures/web-app'

const input = '[data-testid="message-input"]:visible'
const assistant = '[data-testid="assistant-message"]:visible'

test('prompt completes over authenticated WebSocket and preserves focus', async ({ page, app, isMobile }, testInfo) => {
  const editor = page.locator(input).first()
  await editor.getByRole('textbox').click()
  await page.keyboard.type('QA smoke prompt')
  await expect(editor.getByRole('textbox')).toContainText('QA smoke prompt')
  await page.keyboard.press('Enter')
  await expect(page.locator(assistant).last()).toContainText('This is a mock response')
  if (!isMobile) await expect(editor.locator('.cm-content')).toBeFocused()
  else await expect(editor.getByRole('textbox')).toBeEditable()
  await expect.poll(() => app.sessionIds()).toHaveLength(1)
  if (!isMobile) {
    await testInfo.attach('desktop-focus', { body: await page.screenshot(), contentType: 'image/png' })
    await editor.getByRole('textbox').click()
    await page.keyboard.type('draft survives responsive modes')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('.mobile-shell:visible')).toBeVisible()
    await expect(editor.getByRole('textbox')).toContainText('draft survives responsive modes')
    await expect(page.locator(assistant).last()).toContainText('This is a mock response')
    await page.setViewportSize({ width: 1280, height: 720 })
    await expect(page.locator('.web-frame:visible')).toBeVisible()
    await expect(editor.getByRole('textbox')).toContainText('draft survives responsive modes')
  }
  expect(app.errors).toEqual([])
  expect(app.consoleLines).toEqual([])
})


test('permission, cancel, reload and reconnect preserve the active session', async ({ page, app }) => {
  const editor = page.locator(input).first()
  async function send(text: string) {
    await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0)
    await editor.getByRole('textbox').click()
    await page.keyboard.type(text)
    await expect(editor.getByRole('textbox')).toContainText(text)
    await page.keyboard.press('Enter')
  }
  await send('QA permission __MOCK_PERMISSION__')
  const permission = page.locator('[data-testid="permission-card"]:visible')
  await expect(permission).toBeVisible()
  await expect.poll(() => app.sessionIds()).toHaveLength(1)
  const sessionIds = app.sessionIds()
  // Drop the actual transport while the server holds a permission request.
  const connections = app.connectionCount()
  expect(connections).toBeGreaterThan(0)
  await app.disconnect()
  await expect.poll(() => app.connectionCount()).toBeGreaterThan(connections)
  await expect(permission).toBeVisible()
  await permission.locator('[data-kind="allow"]').click()
  await expect(page.locator(assistant).last()).toContainText('Permission approved')

  await page.reload()
  await expect(editor).toBeVisible()
  await expect(page.locator(assistant).last()).toContainText('Permission approved')
  await send('QA follow-up after resume')
  await expect(page.locator(assistant).last()).toContainText('This is a mock response')

  await send('QA cancellation __MOCK_HOLD__')
  const stop = page.getByRole('button', { name: /^Stop/ }).first()
  await expect(stop).toBeVisible()
  await stop.click()
  await expect(stop).toBeHidden()
  const responses = await page.locator(assistant).count()
  await send('QA prompt after cancellation')
  await expect(page.locator(assistant)).toHaveCount(responses + 1)
  await expect(page.locator(assistant).last()).toContainText('This is a mock response')
  expect(app.sessionIds()).toEqual(sessionIds)
  expect(app.errors).toEqual([])
  expect(app.consoleLines).toEqual([])
})
