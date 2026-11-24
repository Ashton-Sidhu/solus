import { test as base, _electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

export { expect } from '@playwright/test'

type Fixtures = {
  electronApp: ElectronApplication
  page: Page
}

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'solus-test-'))
    try {
      const app = await _electron.launch({
        args: [
          join(__dirname, '../../../dist/main/index.js'),
          '--force-device-scale-factor=1',
          `--user-data-dir=${userDataDir}`,
        ],
        env: {
          ...process.env,
          SOLUS_TEST_MODE: '1',
          SOLUS_DATA_DIR: join(userDataDir, 'solus-data'),
          SOLUS_DEV_LOG: join(userDataDir, 'dev.log'),
          SOLUS_DB: 'sqlite',
          DATABASE_URL: '',
          SOLUS_TEST_DATABASE_URL: '',
          ANTHROPIC_API_KEY: 'test-key',
          SOLUS_NO_UPDATE_CHECK: '1',
          ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
          ELECTRON_ENABLE_LOGGING: '1',
        },
      })
      try {
        await use(app)
      } finally {
        await app.close()
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  },

  page: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await use(window)
  },
})
