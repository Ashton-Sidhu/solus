import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))
await page.goto('http://localhost:5199/demo/index.html?standalone', { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForTimeout(9000)
console.log('fixture task visible:', await page.getByText('Expose rate-limit headers').count())
console.log('tabs visible:', await page.getByText('Add rate limiting to the API').count())
await page.screenshot({ path: '/tmp/demo-fixed.png' })
console.log('ERRORS:', errors.slice(0, 6).join(' | ') || 'none')
await browser.close()
