import { chromium } from 'playwright'

export async function openApp(baseURL: string, opts: { videoDir?: string } = {}) {
  const browser = await chromium.launch()
  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: { width: 1440, height: 900 },
  }
  if (opts.videoDir) contextOptions.recordVideo = { dir: opts.videoDir }
  const context = await browser.newContext(contextOptions)
  await context.addInitScript((origin: string) => {
    localStorage.setItem('solus.servers', JSON.stringify([
      { id: 'local', label: 'Agent', url: origin, sessionToken: '', lastConnected: Date.now() },
    ]))
    localStorage.setItem('solus.activeServerId', 'local')
  }, baseURL)
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.locator('[data-testid="message-input"]').first().waitFor({ timeout: 15_000 })
  return { browser, context, page }
}
