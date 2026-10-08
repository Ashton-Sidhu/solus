import { afterAll, beforeAll, describe, expect, mock, setSystemTime, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const directory = mkdtempSync(join(tmpdir(), 'solus-automation-recent-runs-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = directory
let store: typeof import('@solus/server/data/automations/automations-store')
let db: typeof import('@solus/server/db')

beforeAll(async () => {
  store = await import('@solus/server/data/automations/automations-store')
  db = await import('@solus/server/db')
})
afterAll(() => {
  setSystemTime()
  db.closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(directory, { recursive: true, force: true })
})

const action = {
  prompt: 'Summarise the day.', agentProvider: 'codex' as const,
  modelId: null, reasoningEffort: 'medium' as const, cwd: directory,
}

let minute = 0

/** Start and finish `count` runs, one minute apart, each with a final message. */
async function runTimes(automationId: string, count: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    setSystemTime(new Date(Date.UTC(2026, 9, 8, 12, minute++)))
    const run = await store.startRun(automationId)
    await store.finishRun(automationId, run.id, { status: 'succeeded', output: 'A long final message.' })
    ids.push(run.id)
  }
  return ids
}

describe('listRecentRuns', () => {
  test('returns each automation\'s newest runs, newest first, without their output', async () => {
    // The list draws one graph per automation from this one call, so every
    // automation gets its own window and no run carries its final text.
    const busy = await store.createAutomation('Busy', action, { kind: 'system' }, true, { type: 'manual' })
    const quiet = await store.createAutomation('Quiet', action, { kind: 'system' }, true, { type: 'manual' })
    const busyRuns = await runTimes(busy.id, 4)
    const quietRuns = await runTimes(quiet.id, 1)

    const recent = await store.listRecentRuns(3)

    expect(recent.filter((run) => run.automationId === busy.id).map((run) => run.id))
      .toEqual(busyRuns.slice(-3).reverse())
    expect(recent.filter((run) => run.automationId === quiet.id).map((run) => run.id)).toEqual(quietRuns)
    expect(recent.every((run) => !('output' in run) && run.finishedAt !== undefined)).toBe(true)
  })
})
