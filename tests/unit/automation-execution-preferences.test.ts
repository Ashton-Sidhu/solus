import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { DEFAULT_EXECUTION_PREFERENCES, type ExecutionPreferences } from '@solus/contracts/settings'
import type { AutomationAction, Automation } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/018 §6, host side: an automation runs with the preferences its creator
// or last editor sent, captured with it, so it runs the same way while no client
// is there. One with no captured preferences is work no person's preferences
// describe, and runs with the built-in defaults, never the host's config.
// Archived-automation retention stays the host's.

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-automation-preferences-'))
  process.env.SOLUS_DATA_DIR = dataDir
})

afterAll(async () => {
  const db = await import('@solus/server/db')
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const action: AutomationAction = { prompt: 'Summarize the day', agentProvider: 'codex', modelId: null, reasoningEffort: 'medium', cwd: '/tmp' }

/** Runs the automation once and answers the preferences its session was dispatched with. */
async function runOnce(automation: Automation): Promise<ExecutionPreferences | undefined> {
  const runner = await import('@solus/server/execution/automations/automation-runner')
  let seen: ExecutionPreferences | undefined
  runner.setAutomationBackgroundSessionDispatcher(async (options) => {
    seen = options.executionPreferences
    return { agentSessionId: `run-${Date.now()}`, done: Promise.resolve({ output: 'ok' }) }
  })
  const run = await runner.triggerAutomationRun(automation)
  for (let i = 0; i < 50 && runner.hasActiveRun(automation.id); i++) await new Promise((resolve) => setTimeout(resolve, 1))
  expect(run.automationId).toBe(automation.id)
  return seen
}

async function hostAttribution() {
  const { HOST_ACTOR, attributionOf } = await import('@solus/server/admission/actor')
  return attributionOf(HOST_ACTOR)
}

describe('an automation runs with the preferences captured with it', () => {
  test("an automation created with preferences runs with the creator's", async () => {
    const store = await import('@solus/server/data/automations/automations-store')
    const saved = await store.createAutomation('Hourly', action, await hostAttribution(), true, { type: 'manual' }, { extraInstructions: 'Creator.' })
    expect(saved.executionPreferences?.preferences).toEqual({ extraInstructions: 'Creator.' })
    expect((await runOnce(saved))?.extraInstructions).toBe('Creator.')
  })

  test("an edit that carries the editor's preferences replaces the captured ones", async () => {
    const store = await import('@solus/server/data/automations/automations-store')
    const saved = await store.createAutomation('Weekly', action, await hostAttribution(), true, { type: 'manual' }, { extraInstructions: 'Creator.' })
    const edited = await store.updateAutomation(saved.id, { executionPreferences: { extraInstructions: 'Mine now.' } })
    expect(edited?.executionPreferences?.preferences).toEqual({ extraInstructions: 'Mine now.' })
    expect((await runOnce(edited!))?.extraInstructions).toBe('Mine now.')
    // An edit that carries none leaves the captured preferences as they were.
    const renamed = await store.updateAutomation(saved.id, { name: 'Weekly digest' })
    expect(renamed?.executionPreferences?.preferences).toEqual({ extraInstructions: 'Mine now.' })
  })

  test('an automation with no captured preferences runs with the built-in defaults, and none is written for it', async () => {
    const store = await import('@solus/server/data/automations/automations-store')
    const saved = await store.createAutomation('Daily', action, await hostAttribution())
    expect(saved.executionPreferences).toBeUndefined()
    expect(await runOnce(saved)).toEqual(DEFAULT_EXECUTION_PREFERENCES)
    expect((await store.loadAutomation(saved.id))?.executionPreferences).toBeUndefined()
  })
})

describe('retention ownership', () => {
  test('archived automations are cleaned up by the host retention', async () => {
    const store = await import('@solus/server/data/automations/automations-store')
    const saved = await store.createAutomation('Archived', { ...action, prompt: 'Old' }, await hostAttribution())
    await store.updateAutomation(saved.id, { archived: true })
    const tenDaysLater = new Date(Date.now() + 10 * 86_400_000)
    // Deletion follows the host's retention alone: 30 days keeps it, 7 days removes it.
    expect(store.deleteExpiredArchivedAutomations(30, tenDaysLater)).toBe(0)
    expect(await store.loadAutomation(saved.id)).not.toBeNull()
    expect(store.deleteExpiredArchivedAutomations(7, tenDaysLater)).toBe(1)
    expect(await store.loadAutomation(saved.id)).toBeNull()
  })
})
