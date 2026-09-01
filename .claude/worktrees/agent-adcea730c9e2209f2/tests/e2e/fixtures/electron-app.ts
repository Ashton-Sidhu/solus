import { test as base, _electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'

export { expect } from '@playwright/test'

type Fixtures = {
  electronApp: ElectronApplication
  page: Page
}

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'solus-test-'))
    const app = await _electron.launch({
      args: [
        join(__dirname, '../../../dist/main/index.js'),
        '--force-device-scale-factor=1',
        `--user-data-dir=${userDataDir}`,
      ],
      env: {
        ...process.env,
        SOLUS_TEST_MODE: '1',
        ANTHROPIC_API_KEY: 'test-key',
        SOLUS_NO_UPDATE_CHECK: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        ELECTRON_ENABLE_LOGGING: '1',
      },
    })
    await use(app)
    await app.close()
  },

  page: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await use(window)
  },
})
