import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
const port = process.env.PORT!
const origin = `http://127.0.0.1:${port}`
await mkdir('.solus-local/artifacts', { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript((o) => {
  localStorage.setItem('solus.servers', JSON.stringify([
    { id: 'local', label: 'Agent', url: o, sessionToken: '', lastConnected: Date.now() },
  ]))
  localStorage.setItem('solus.activeServerId', 'local')
}, origin)
const page = await ctx.newPage()
const errs: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
await page.goto(origin)
await page.waitForTimeout(5000)
await page.screenshot({ path: '.solus-local/artifacts/boot.png', fullPage: true })
console.log('[boot] bodyText=', (await page.evaluate(() => document.body.innerText)).slice(0, 600))
console.log('[boot] rootHTML=', (await page.evaluate(() => document.querySelector('#app,#root,body')?.innerHTML ?? '')).slice(0, 1200))
console.log('[boot] consoleErrors=', JSON.stringify(errs.slice(0, 12)))
await browser.close()
