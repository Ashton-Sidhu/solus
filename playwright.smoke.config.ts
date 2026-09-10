import { defineConfig, devices } from '@playwright/test'
import type { MockProvider } from './tests/e2e/fixtures/web-app'

export default defineConfig<{ provider: MockProvider }>({
  testDir: 'tests/e2e/smoke',
  globalSetup: require.resolve('./tests/e2e/global-setup'),
  fullyParallel: true,
  workers: 2,
  timeout: 45_000,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '.solus-local/reports/smoke', open: 'never' }]],
  outputDir: '.solus-local/reports/smoke-results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    ...(['claude-code', 'codex'] as const).flatMap((provider) => [
      { name: `web-${provider}`, testMatch: 'behavior.spec.ts', use: { ...devices['Desktop Chrome'], provider } },
      { name: `mobile-web-${provider}`, testMatch: 'behavior.spec.ts', use: { ...devices['Pixel 7'], provider } },
    ]),
    { name: 'electron-native', testMatch: 'native.spec.ts' },
  ],
})
