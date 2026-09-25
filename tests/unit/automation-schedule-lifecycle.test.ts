import { afterAll, beforeAll, describe, expect, mock, test, setSystemTime } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_HOST_CONFIG, hostConfigPatchSchema } from '@solus/contracts/host-config'
import { scheduleCardState } from '@solus/workspace-ui/components/automations/lib/schedule-card'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const directory = mkdtempSync(join(tmpdir(), 'solus-automation-schedule-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = directory
let store: typeof import('@solus/server/automations/automations-store')
let db: typeof import('@solus/server/db')
let automationTools: typeof import('@solus/server/automations/automation-tools')

beforeAll(async () => {
  store = await import('@solus/server/automations/automations-store')
  db = await import('@solus/server/db')
  automationTools = await import('@solus/server/automations/automation-tools')
})
afterAll(() => {
  db.closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(directory, { recursive: true, force: true })
})

const action = {
  prompt: 'Check CI until it passes.', agentProvider: 'codex' as const,
  modelId: null, reasoningEffort: 'medium' as const, cwd: directory,
}

describe('automation schedule lifecycle', () => {
  test('a missed one-time check fires once after reopening the store and shows completion', async () => {
    const once = await store.createAutomation('Once', action, { kind: 'user' }, true, {
      type: 'once', runAt: new Date(Date.now() + 60_000).toISOString(),
    })
    db.closeDb()
    const dueTime = new Date(Date.now() + 120_000)
    expect((await store.claimDueAutomations(dueTime)).map(item => item.id)).toEqual([once.id])
    expect(await store.claimDueAutomations(dueTime)).toEqual([])
    setSystemTime(dueTime)
    const run = await store.startRun(once.id)
    await store.finishRun(once.id, run.id, { status: 'succeeded' })
    setSystemTime()
    const finished = (await store.loadAutomation(once.id))!
    expect(scheduleCardState({ ...finished, lastRunAt: dueTime.toISOString() })).toBe('Schedule complete')
    expect(scheduleCardState({ ...finished, lastRunAt: new Date(Date.now()).toISOString() })).toBe('Paused')
  })

  test('pause preserves timing, resume rearms it, and stop keeps history without future checks', async () => {
    const saved = await store.createAutomation('Stop', action, { kind: 'user' }, true, { type: 'interval', everyMinutes: 30 })
    const paused = (await store.updateAutomation(saved.id, { enabled: false }))!
    expect(scheduleCardState(paused)).toBe('Paused')
    expect(paused.trigger).toEqual(saved.trigger)
    expect(paused.nextRunAt).toBeUndefined()
    expect((await store.updateAutomation(saved.id, { enabled: true }))?.nextRunAt).toBeDefined()
    const run = await store.startRun(saved.id)
    await store.finishRun(saved.id, run.id, { status: 'succeeded' })
    const result = await automationTools.executeAutomationTool('update_automation', {
      automation_id: saved.id, archived: true,
    })
    expect(result.ok).toBe(true)
    expect(scheduleCardState((await store.loadAutomation(saved.id))!)).toBe('Stopped')
    expect(await store.listRuns(saved.id)).toHaveLength(1)
    expect(await store.claimDueAutomations(new Date(Date.now() + 86_400_000))).toEqual([])
  })
  test('archive retention defaults to 30 days and rejects unsafe periods', () => {
    expect(DEFAULT_HOST_CONFIG.archivedAutomationRetentionDays).toBe(30)
    for (const days of [0, -1, 1.5, 3651]) {
      expect(hostConfigPatchSchema.safeParse({ archivedAutomationRetentionDays: days }).success).toBe(false)
    }
    expect(hostConfigPatchSchema.parse({ archivedAutomationRetentionDays: 7 }).archivedAutomationRetentionDays).toBe(7)
  })

  test('archiving a running check waits for completion and preserves cadence', async () => {
    const saved = await store.createAutomation('Finishing', action, { kind: 'user' }, true, { type: 'interval', everyMinutes: 30 })
    const run = await store.startRun(saved.id)
    const stopping = (await store.updateAutomation(saved.id, { archived: true }))!
    expect(stopping.archivedAt).toBeUndefined()
    expect(stopping.archiveRequested).toBe(true)
    expect(stopping.enabled).toBe(false)
    await store.finishRun(saved.id, run.id, { status: 'succeeded' })
    const archived = (await store.loadAutomation(saved.id))!
    expect(archived.archivedAt).toBeDefined()
    expect(archived.archiveRequested).toBeUndefined()
    expect(archived.trigger).toEqual(saved.trigger)
    const restored = (await store.updateAutomation(saved.id, { archived: false }))!
    expect(restored.archivedAt).toBeUndefined()
    expect(restored.enabled).toBe(false)
  })

  test('a failed check stays visible even when it was stopping', async () => {
    const saved = await store.createAutomation('Failed', action, { kind: 'user' }, true, { type: 'interval', everyMinutes: 30 })
    const run = await store.startRun(saved.id)
    await store.updateAutomation(saved.id, { archived: true })
    await store.finishRun(saved.id, run.id, { status: 'failed', error: 'Host unreachable' })
    const failed = (await store.loadAutomation(saved.id))!
    expect(failed.archivedAt).toBeUndefined()
    expect(failed.archiveRequested).toBeUndefined()
    expect(failed.lastRunStatus).toBe('failed')
  })

  test('expiry starts at archive time, cascades run history, and leaves paused schedules alone', async () => {
    const saved = await store.createAutomation('Expire', action, { kind: 'user' }, true, { type: 'interval', everyMinutes: 30 })
    const paused = await store.createAutomation('Keep paused', action, { kind: 'user' }, false, { type: 'interval', everyMinutes: 30 })
    const run = await store.startRun(saved.id)
    await store.finishRun(saved.id, run.id, { status: 'succeeded' })
    const archived = (await store.updateAutomation(saved.id, { archived: true }))!
    const archivedAt = Date.parse(archived.archivedAt!)
    db.closeDb()
    store.deleteExpiredArchivedAutomations(30, new Date(archivedAt + 30 * 86_400_000 - 1))
    expect(await store.loadAutomation(saved.id)).not.toBeNull()
    // A new shorter policy also applies to existing archives.
    store.deleteExpiredArchivedAutomations(7, new Date(archivedAt + 7 * 86_400_000), id => id === saved.id)
    expect(await store.loadAutomation(saved.id)).not.toBeNull()
    store.deleteExpiredArchivedAutomations(7, new Date(archivedAt + 7 * 86_400_000))
    expect(await store.loadAutomation(saved.id)).toBeNull()
    expect(await store.listRuns(saved.id)).toEqual([])
    expect(await store.loadAutomation(paused.id)).not.toBeNull()
  })

})
