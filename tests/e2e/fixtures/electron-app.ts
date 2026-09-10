import { test as base, _electron, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { join, resolve } from 'node:path'
import { appendFileSync, readFileSync, existsSync, realpathSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { assertTestBuild } from '../../../scripts/qa/build-identity'
import { mockEnvironment } from '../../../scripts/qa/runner'
import { attachFailure, observePage } from './evidence'

export { expect } from '@playwright/test'
const root = resolve(__dirname, '../../..')
type Fixtures = { electronApp: ElectronApplication; page: Page; verifyErrors: boolean }

export const test = base.extend<Fixtures>({
  verifyErrors: [false, { option: true }],
  electronApp: async ({ verifyErrors }, use, testInfo) => {
    assertTestBuild(root)
    const directory = mkdtempSync(join(tmpdir(), 'solus-test-'))
    const logDir = join(directory, 'logs')
    mkdirSync(logDir)
    const dataDir = join(directory, 'data')
    const projectDir = join(dataDir, 'my-workspace')
    mkdirSync(projectDir, { recursive: true })
    execFileSync('git', ['init', '--quiet', projectDir], { env: mockEnvironment(root, dataDir, logDir) })
    let app: ElectronApplication | undefined
    let window: Page | undefined
    let setupFailed = false
    let observations: ReturnType<typeof observePage> = { errors: [], consoleLines: [] }
    try {
      app = await _electron.launch({
        args: [join(root, 'dist/test/main/index.js'), '--force-device-scale-factor=1', `--user-data-dir=${directory}`],
        env: mockEnvironment(root, dataDir, logDir),
      })
      app.process().stdout?.on('data', (data: Buffer) => appendFileSync(join(logDir, 'console.log'), data))
      app.process().stderr?.on('data', (data: Buffer) => appendFileSync(join(logDir, 'console.log'), data))
      expect(realpathSync(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(realpathSync(directory))
      await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
      window = await app.firstWindow()
      observations = observePage(window)
      await window.getByRole('button', { name: 'Skip setup', exact: true }).click()
      await use(app)
      const historyPath = join(dataDir, 'mock-history', 'claude-code.json')
      if (existsSync(historyPath)) {
        const history = readFileSync(historyPath, 'utf8')
        await testInfo.attach('mock-history', { body: history, contentType: 'application/json' })
        for (const session of z.array(z.object({ cwd: z.string() })).parse(JSON.parse(history))) {
          expect(realpathSync(session.cwd)).toBe(realpathSync(projectDir))
        }
      }
      if (verifyErrors) {
        expect(observations.errors).toEqual([])
        expect(observations.consoleLines).toEqual([])
      }
    } catch (error) {
      setupFailed = true
      throw error
    } finally {
      try {
        await attachFailure(window, testInfo, observations, logDir, setupFailed)
        if (app) {
          const failed = testInfo.status !== testInfo.expectedStatus
          const path = failed ? testInfo.outputPath('electron-trace.zip') : undefined
          await app.context().tracing.stop({ path })
          if (path) await testInfo.attach('electron-trace', { path, contentType: 'application/zip' })
        }
      } finally {
        await app?.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  },
  page: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await use(window)
  },
})
