import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'

export interface AppConnection {
  url: string
  sessionToken: string
  projectPath?: string
  provider?: 'claude-code' | 'codex'
}

/** Seeds a disposable browser identity. The host issues this test credential. */
export async function connectApp(context: BrowserContext, page: Page, connection: AppConnection) {
  await context.addInitScript(({ url, sessionToken, provider }: AppConnection) => {
    // Preserve subsequent user choices and workspace state on reload.
    if (!localStorage.getItem('solus-settings')) {
      localStorage.setItem('solus-settings', JSON.stringify({ onboardingCompleted: true, activeAgent: provider ?? 'claude-code' }))
    }
    if (localStorage.getItem('solus.servers')) return
    localStorage.setItem('solus.servers', JSON.stringify([
      { id: 'local', label: 'QA host', url, sessionToken, lastConnected: Date.now() },
    ]))
    localStorage.setItem('solus.activeServerId', 'local')
  }, connection)
  await page.goto(connection.url)
  await page.locator('[data-testid="message-input"]:visible').first().waitFor({ timeout: 15_000 })
  if (connection.projectPath) await selectProject(page, connection.projectPath)
}

export async function selectProject(page: Page, projectPath: string) {
  // Set this draft's execution directory. The global project picker changes
  // the workspace default and can leave an already-mounted draft unchanged.
  await page.locator('button[aria-label^="Change project — currently"]:visible').click()
  await page.getByRole('option', { name: 'New project', exact: true }).click()
  const picker = page.locator('#directory-picker[role="dialog"]')
  await picker.getByRole('combobox', { name: 'Folder path' }).fill(`${projectPath}/`)
  await expect(picker.locator('nav[aria-label="Path breadcrumbs"] button').last()).toHaveAttribute('title', `${projectPath}/`)
  await picker.locator('footer button').last().click()
  await expect(picker).toBeHidden()
}

export async function openApp(baseURL: string, opts: { videoDir?: string; sessionToken?: string; projectPath?: string; viewport?: { width: number; height: number }; hasTouch?: boolean } = {}) {
  const browser = await chromium.launch()
  try {
    const contextOptions: Parameters<typeof browser.newContext>[0] = {
      viewport: opts.viewport ?? { width: 1440, height: 900 },
      hasTouch: opts.hasTouch ?? false,
    }
    if (opts.videoDir) contextOptions.recordVideo = { dir: opts.videoDir }
    const context = await browser.newContext(contextOptions)
    const page = await context.newPage()
    await connectApp(context, page, { url: baseURL, sessionToken: opts.sessionToken ?? '', projectPath: opts.projectPath })
    return { browser, context, page }
  } catch (error) {
    await browser.close()
    throw error
  }
}
