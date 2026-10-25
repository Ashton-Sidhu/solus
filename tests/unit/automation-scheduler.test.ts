import { afterAll, afterEach, beforeAll, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// The scheduler wakes only when an automation is due. An idle host must not wake on a
// clock, and a due automation must still fire at its wall-clock time, also after the
// machine sleeps. These tests hold the scheduler's one timer and move the wall clock.

const directory = mkdtempSync(join(tmpdir(), 'solus-automation-scheduler-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = directory
let store: typeof import('@solus/server/data/automations/automations-store')
let db: typeof import('@solus/server/db')
let runner: typeof import('@solus/server/execution/automations/automation-runner')
let scheduler: typeof import('@solus/server/execution/automations/automation-scheduler')

const MAX_WAIT_MS = 5 * 60_000
const START = Date.parse('2026-10-14T09:00:00.000Z')

// The scheduler's timer, held here. Other timers (the logger) run as usual.
type HeldTimer = { callback: () => void; ms: number; unref: () => void }
let held: HeldTimer | null = null
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
  if (callback.name !== 'wake') return realSetTimeout(callback, ms)
  held = { callback, ms: ms ?? 0, unref: () => {} }
  return held
}) as unknown as typeof setTimeout)
const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: unknown) => {
  if (handle === held) held = null
  else realClearTimeout(handle as ReturnType<typeof setTimeout>)
}) as typeof clearTimeout)

// No clock may wake the scheduler on its own.
const setIntervalSpy = spyOn(globalThis, 'setInterval')

// Each run waits until the test ends it.
const dispatched: string[] = []
const endRuns: Array<() => void> = []

beforeAll(async () => {
  store = await import('@solus/server/data/automations/automations-store')
  db = await import('@solus/server/db')
  runner = await import('@solus/server/execution/automations/automation-runner')
  scheduler = await import('@solus/server/execution/automations/automation-scheduler')
  runner.setAutomationBackgroundSessionDispatcher(async ({ automationId }) => {
    dispatched.push(automationId)
    return { sessionId: `session-${dispatched.length}`, done: new Promise((resolve) => endRuns.push(() => resolve({ output: 'done' }))) }
  })
})
afterEach(async () => {
  scheduler.stopAutomationScheduler()
  for (const end of endRuns.splice(0)) end()
  await settle()
  for (const automation of await store.listAutomations()) await store.deleteAutomation(automation.id)
  dispatched.length = 0
  held = null
  setSystemTime()
})
afterAll(() => {
  setTimeoutSpy.mockRestore()
  setIntervalSpy.mockRestore()
  clearTimeoutSpy.mockRestore()
  db.closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(directory, { recursive: true, force: true })
})

const action = {
  prompt: 'Check CI.', agentProvider: 'codex' as const,
  modelId: null, reasoningEffort: 'medium' as const, cwd: directory,
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function start(): Promise<void> {
  scheduler.startAutomationScheduler()
  await settle()
}

/** Fire the held timer at the current wall-clock time. */
async function fire(): Promise<void> {
  const timer = held
  expect(timer).not.toBeNull()
  held = null
  timer!.callback()
  await settle()
}

describe('automation scheduler', () => {
  test('an idle host sets no timer, also with only paused, manual, or archived automations', async () => {
    setSystemTime(new Date(START))
    await store.createAutomation('Manual', action, { kind: 'system' }, true, { type: 'manual' })
    await store.createAutomation('Paused', action, { kind: 'system' }, false, { type: 'interval', everyMinutes: 30 })
    const archived = await store.createAutomation('Archived', action, { kind: 'system' }, true, { type: 'interval', everyMinutes: 30 })
    await store.updateAutomation(archived.id, { archived: true })
    setIntervalSpy.mockClear()
    await start()
    expect(held).toBeNull()
    expect(setIntervalSpy).not.toHaveBeenCalled()
  })

  test('one timer fires a due automation at its time and is set again for its next run', async () => {
    setSystemTime(new Date(START))
    const saved = await store.createAutomation('Every 2 min', action, { kind: 'system' }, true, { type: 'interval', everyMinutes: 2 })
    await start()
    expect(held?.ms).toBe(2 * 60_000)

    setSystemTime(new Date(START + 2 * 60_000))
    await fire()
    expect(dispatched).toEqual([saved.id])
    // While its run is in progress, the automation cannot fire again: no timer is set for it.
    expect(held).toBeNull()

    endRuns.shift()!()
    await settle()
    expect(held?.ms).toBe(2 * 60_000)
  })

  test('a wait is at most five minutes, and the automation fires at its wall-clock time after a sleep', async () => {
    setSystemTime(new Date(START))
    const saved = await store.createAutomation('In 3 h', action, { kind: 'system' }, true, {
      type: 'once', runAt: new Date(START + 3 * 3_600_000).toISOString(),
    })
    await start()
    expect(held?.ms).toBe(MAX_WAIT_MS)

    setSystemTime(new Date(START + MAX_WAIT_MS))
    await fire()
    expect(dispatched).toEqual([])
    expect(held?.ms).toBe(MAX_WAIT_MS)

    // The machine slept; the late wake reads the real time and claims the due automation.
    setSystemTime(new Date(START + 3 * 3_600_000 + 1_000))
    await fire()
    expect(dispatched).toEqual([saved.id])
  })

  test('a change to the automations sets or clears the timer', async () => {
    setSystemTime(new Date(START))
    await start()
    expect(held).toBeNull()

    const saved = await store.createAutomation('Hourly', action, { kind: 'system' }, true, { type: 'interval', everyMinutes: 60 })
    expect(held?.ms).toBe(MAX_WAIT_MS)
    await store.updateAutomation(saved.id, { enabled: false })
    expect(held).toBeNull()
    await store.updateAutomation(saved.id, { enabled: true })
    expect(held?.ms).toBe(MAX_WAIT_MS)
    await store.updateAutomation(saved.id, { trigger: { type: 'interval', everyMinutes: 3 } })
    expect(held?.ms).toBe(3 * 60_000)
    await store.deleteAutomation(saved.id)
    expect(held).toBeNull()
  })

  test('an automation skipped while its previous run is active fires when that run ends', async () => {
    setSystemTime(new Date(START))
    const saved = await store.createAutomation('Overlap', action, { kind: 'system' }, true, { type: 'interval', everyMinutes: 2 })
    await runner.triggerAutomationRun(saved)
    await settle()
    expect(dispatched).toEqual([saved.id])

    // Due while its manual run is still active: the start tick skips it, and no timer spins on it.
    setSystemTime(new Date(START + 3 * 60_000))
    await start()
    expect(dispatched).toEqual([saved.id])
    expect(held).toBeNull()

    endRuns.shift()!()
    await settle()
    expect(dispatched).toEqual([saved.id, saved.id])
  })

  test('stop clears the timer and later changes set no new one', async () => {
    setSystemTime(new Date(START))
    await store.createAutomation('Hourly', action, { kind: 'system' }, true, { type: 'interval', everyMinutes: 60 })
    await start()
    expect(held).not.toBeNull()
    scheduler.stopAutomationScheduler()
    expect(held).toBeNull()
    await store.createAutomation('Later', action, { kind: 'system' }, true, { type: 'interval', everyMinutes: 30 })
    expect(held).toBeNull()
  })
})
