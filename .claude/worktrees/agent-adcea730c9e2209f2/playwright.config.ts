import { defineConfig } from '@playwright/test'
import os from 'os'

// Local: use half the cores (Electron is heavy and we don't want to starve the machine).
// CI: cap at 4 to avoid flakes on shared runners.
const LOCAL_WORKERS = Math.max(2, Math.floor(os.cpus().length / 2))
const CI_WORKERS = 4

export default defineConfig({
  testDir: 'tests/e2e/workflows',
  globalSetup: require.resolve('./tests/e2e/global-setup'),
  fullyParallel: true,
  workers: process.env.CI ? CI_WORKERS : LOCAL_WORKERS,
  timeout: 30_000,
  retries: 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
})
