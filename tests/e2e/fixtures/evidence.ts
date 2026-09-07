import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, TestInfo } from '@playwright/test'

/** Errors are kept for the assertion and for a useful failure report. */
export function observePage(page: Page) {
  const errors: string[] = []
  const consoleLines: string[] = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    // Avoid storing full URLs, connection credentials or arbitrary console arguments.
    if (message.type() === 'error') consoleLines.push(message.text().replace(/https?:\/\/\S+/g, '[url]'))
  })
  return { errors, consoleLines }
}

export async function attachFailure(page: Page | undefined, testInfo: TestInfo, observations: ReturnType<typeof observePage>, logDir: string, force = false) {
  if (!force && testInfo.status === testInfo.expectedStatus) return
  if (page && !page.isClosed()) {
    await testInfo.attach('focus-events', { body: await page.evaluate(() => sessionStorage.getItem('qa-focus-events') ?? '[]'), contentType: 'application/json' })
    await testInfo.attach('focus-state', { body: JSON.stringify(await page.evaluate(() => ({
      activeTag: document.activeElement?.tagName, activeClass: document.activeElement?.getAttribute('class'),
      activeRole: document.activeElement?.getAttribute('role'),
      visibleInputs: [...document.querySelectorAll('[data-testid="message-input"]')].filter((element) => element.getBoundingClientRect().height > 0).length,
    }))), contentType: 'application/json' })
    await testInfo.attach('failure', { body: await page.screenshot(), contentType: 'image/png' })
  }
  await testInfo.attach('renderer-errors', { body: JSON.stringify(observations), contentType: 'application/json' })
  if (existsSync(logDir)) {
    for (const name of readdirSync(logDir)) {
      if (!name.endsWith('.log')) continue
      // Structured host logs may contain conversation text. These remain local QA artifacts.
      await testInfo.attach(name, { body: readFileSync(join(logDir, name)), contentType: 'text/plain' })
    }
  }
}
