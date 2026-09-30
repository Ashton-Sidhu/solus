import { chromium } from 'playwright'

export async function openApp(baseURL: string, opts: { videoDir?: string; skipOnboarding?: boolean } = {}) {
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
  const url = new URL(baseURL)
  if (opts.skipOnboarding !== false) url.searchParams.set('skip-onboarding', '')
  await page.goto(url.toString())
  await page.locator('[data-testid="message-input"]').first().waitFor({ timeout: 15_000 })
  return { browser, context, page }
}
