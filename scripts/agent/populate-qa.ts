import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { mockEnvironment, runStatus } from '../qa/runner'
import { openApp } from './open-app'
import { populateVisualScenario, visualScenarios } from '../../tests/e2e/fixtures/scenarios'

const root = process.cwd()
const runId = process.argv[2]
const scenario = z.enum(visualScenarios).parse(process.argv[3])
if (!runId) throw new Error('Usage: bun scripts/agent/populate-qa.ts <run-id> <scenario>')
const run = await runStatus(root, runId)
if (run.status !== 'running' || run.error) throw new Error(run.error ?? 'QA run must be running')
const environment = mockEnvironment(root, run.dataDir, run.logDir)
const credential = z.object({ sessionToken: z.string() }).parse(JSON.parse(execFileSync('node', [
  join(root, 'dist/test/main/standalone.js'), 'auth', 'session', 'create', '--device-label', 'QA visual', '--json',
], { cwd: root, env: environment, encoding: 'utf8' })))
const projectPath = run.projectDir
const { browser, context, page } = await openApp(run.url, { sessionToken: credential.sessionToken, projectPath })
try {
  await populateVisualScenario(page, scenario, projectPath)
  const screenshot = join(run.directory, `${run.generationId}-${scenario}.png`)
  await page.screenshot({ path: screenshot })
  // Private state allows a later Playwright review to restore these tabs. Never publish it.
  writeFileSync(join(run.directory, 'browser-state.json'), JSON.stringify(await context.storageState()), { mode: 0o600 })
  writeFileSync(join(run.directory, 'scenario.json'), JSON.stringify({ scenario, projectPath, screenshot, sourceFingerprint: run.sourceFingerprint, generationId: run.generationId, purpose: 'visual review; not behavioral verification' }, null, 2))
  process.stdout.write(`Populated ${scenario}. Screenshot: ${screenshot}\n`)
} finally {
  await browser.close()
}
