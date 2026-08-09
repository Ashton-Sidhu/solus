import { mkdir } from 'node:fs/promises'
import { openApp } from './open-app'

const port = process.env.PORT
if (!port) throw new Error('PORT is required')
const ART = '.solus-local/artifacts'
await mkdir(ART, { recursive: true })

const { browser, page } = await openApp(`http://127.0.0.1:${port}`)
const shot = (n: string) => page.screenshot({ path: `${ART}/${n}.png`, fullPage: true })
const log = (...a: unknown[]) => console.log('[repro]', ...a)

async function dismissSetup() {
  const skip = page.getByText('Skip setup', { exact: false })
  if (await skip.count()) { await skip.first().click(); await page.waitForTimeout(600) }
}
async function sendPrompt(text: string) {
  const input = page.locator('[data-testid="message-input"]').first()
  await input.click()
  await input.pressSequentially(text)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2500)
}
async function newTask() {
  await page.getByText('New task', { exact: true }).first().click()
  await page.waitForTimeout(600)
}
async function openPicker() {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('solus:toggle-session-picker')))
  await page.waitForTimeout(1000)
}
async function readPicker() {
  return page.evaluate(() => {
    const dialog = document.querySelector('[aria-label="Session picker"]') as HTMLElement | null
    if (!dialog) return { open: false as const }
    const listbox = dialog.querySelector('[role="listbox"]') as HTMLElement | null
    const footerMatch = dialog.innerText.match(/\d+( of \d+)? sessions?/)
    return {
      open: true as const,
      footer: footerMatch?.[0] ?? null,
      rows: listbox
        ? [...listbox.querySelectorAll('*')]
            .map((el) => (el as HTMLElement).innerText?.split('\n')[0]?.trim())
            .filter((t): t is string => !!t && t.length < 80)
            .filter((t, i, arr) => arr.indexOf(t) === i)
        : [],
    }
  })
}
async function closePicker() {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}
async function sidebarTasks() {
  return page.evaluate(() =>
    [...document.querySelectorAll('aside, [class*="sidebar"]')].length
      ? [...document.querySelectorAll('*')]
          .filter((e) => (e as HTMLElement).innerText?.startsWith('repro session'))
          .map((e) => (e as HTMLElement).innerText.split('\n')[0].trim())
          .filter((t, i, a) => a.indexOf(t) === i)
      : [],
  )
}

try {
  await dismissSetup()
  await sendPrompt('repro session ALPHA respond')
  await newTask()
  await sendPrompt('repro session BRAVO respond')
  await shot('10-two-sessions')

  await openPicker()
  await shot('11-picker-two')
  const p1 = await readPicker()
  log('after A+B — picker footer:', p1.open ? p1.footer : 'CLOSED')
  log('after A+B — picker rows:', JSON.stringify(p1.open ? p1.rows : []))
  await closePicker()

  // Now navigate back to ALPHA via its sidebar task, then reopen picker.
  const alpha = page.getByText('repro session ALPHA', { exact: false }).first()
  if (await alpha.count()) { await alpha.click(); await page.waitForTimeout(1500) }
  await shot('12-viewing-alpha')
  await openPicker()
  await shot('13-picker-after-view')
  const p2 = await readPicker()
  log('after viewing ALPHA — picker footer:', p2.open ? p2.footer : 'CLOSED')
  log('after viewing ALPHA — picker rows:', JSON.stringify(p2.open ? p2.rows : []))
} catch (err) {
  log('ERROR', String(err))
  await shot('99-error')
} finally {
  await browser.close()
}
