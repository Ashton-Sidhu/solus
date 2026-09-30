import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionStatus } from '@solus/contracts/types'
import type { UplinkLinkConfig } from '@solus/contracts/uplink'
import { adoptProvisionedLink, resetHostCategoryForTests } from '@solus/server/host/host-category'
import { DUE_HOLD_LEAD_MS, SpriteActivity } from '@solus/server/host/sprite-activity'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// Plan 004 item 3: a Sprite pauses when no request arrives, and a turn makes only
// outbound calls. The managed host holds itself awake while it has work, and tells
// the control plane whether it is busy and when the next automation is due, so a
// paused machine is woken in time. The report must be right, or the machine sleeps
// through a waiting approval or a scheduled run.

const directory = mkdtempSync(join(tmpdir(), 'solus-sprite-activity-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = directory
let store: typeof import('@solus/server/data/automations/automations-store')
let db: typeof import('@solus/server/db')
let SessionRuntime: typeof import('@solus/server/execution/session-runtime')['SessionRuntime']

beforeAll(async () => {
  store = await import('@solus/server/data/automations/automations-store')
  db = await import('@solus/server/db')
  ;({ SessionRuntime } = await import('@solus/server/execution/session-runtime'))
})
afterAll(() => {
  db.closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(directory, { recursive: true, force: true })
})
afterEach(() => resetHostCategoryForTests())

const link = { hostId: 'h1', directoryUrl: 'https://cloud.test', organizationId: 'org1' } as UplinkLinkConfig

describe('what the host reports', () => {
  test('busy while a turn runs or a person owes an answer; not while idle or rate limited', () => {
    const runtime = new SessionRuntime(new Map())
    const sessions = (runtime as unknown as { activeSessions: Map<string, { status: SessionStatus }> }).activeSessions
    try {
      expect(runtime.hasWorkToKeepAwake()).toBe(false)
      for (const status of ['running', 'connecting', 'awaiting_input', 'awaiting_plan'] as const) {
        sessions.set('s1', { status })
        expect(runtime.hasWorkToKeepAwake()).toBe(true)
      }
      // A rate-limit reset can be hours away; holding the machine for it would bill for nothing.
      for (const status of ['idle', 'completed', 'rate_limited'] as const) {
        sessions.set('s1', { status })
        expect(runtime.hasWorkToKeepAwake()).toBe(false)
      }
    } finally {
      sessions.clear()
      runtime.shutdown()
    }
  })

  test('the next due time is the earliest enabled automation; paused and manual ones do not count', async () => {
    const action = { prompt: 'Check CI.', agentProvider: 'codex' as const, modelId: null, reasoningEffort: 'medium' as const, cwd: directory }
    expect(store.nextAutomationDueAt()).toBeNull()
    await store.createAutomation('Manual', action, { kind: 'system' }, true, { type: 'manual' })
    expect(store.nextAutomationDueAt()).toBeNull()
    const soon = new Date(Date.now() + 30 * 60_000).toISOString()
    const later = new Date(Date.now() + 90 * 60_000).toISOString()
    await store.createAutomation('Later', action, { kind: 'system' }, true, { type: 'once', runAt: later })
    const early = await store.createAutomation('Soon', action, { kind: 'system' }, true, { type: 'once', runAt: soon })
    expect(store.nextAutomationDueAt()).toBe(Date.parse(soon))
    await store.updateAutomation(early.id, { enabled: false })
    expect(store.nextAutomationDueAt()).toBe(Date.parse(later))
  })
})

function harness(facts: { busy: boolean; nextDueAt: number | null }) {
  let now = 1_000_000_000
  const tasks: string[] = []
  const reports: unknown[] = []
  const activity = new SpriteActivity({
    isBusy: () => facts.busy,
    nextDueAt: () => facts.nextDueAt,
    link: () => link,
    hostToken: () => 'host-token',
    now: () => now,
    spriteTask: async (method, path, body) => { tasks.push(`${method} ${path}${body ? ` ${body}` : ''}`); return method === 'PUT' ? 200 : 204 },
    fetchImpl: async (url, init) => {
      expect(String(url)).toBe('https://cloud.test/v1/hosts/h1/activity')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer host-token')
      reports.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 204 })
    },
  })
  return { activity, tasks, reports, advance: (ms: number) => { now += ms }, now: () => now }
}

describe('the hold and the report on a managed host', () => {
  test('holds while busy, renews the hold, releases when done, and reports each change once', async () => {
    adoptProvisionedLink({ organizationId: 'org1' })
    const facts = { busy: true, nextDueAt: null as number | null }
    const { activity, tasks, reports, advance } = harness(facts)

    await activity.check()
    expect(tasks).toEqual(['PUT /v1/tasks/solus-work {"expire":600}'])
    expect(reports).toEqual([{ busy: true, nextWakeAt: null }])

    // Nothing changed and the hold is fresh: no call at all.
    advance(60_000)
    await activity.check()
    expect(tasks).toHaveLength(1)
    expect(reports).toHaveLength(1)

    // The hold is renewed before it runs out.
    advance(4 * 60_000)
    await activity.check()
    expect(tasks).toHaveLength(2)

    facts.busy = false
    await activity.check()
    expect(tasks.at(-1)).toBe('DELETE /v1/tasks/solus-work')
    expect(reports.at(-1)).toEqual({ busy: false, nextWakeAt: null })

    // The report is renewed every hour even when nothing changed.
    advance(60 * 60_000)
    await activity.check()
    expect(reports).toHaveLength(3)
  })

  test('holds ahead of a due automation, so the run the control plane woke it for starts', async () => {
    adoptProvisionedLink({ organizationId: 'org1' })
    const facts = { busy: false, nextDueAt: null as number | null }
    const { activity, tasks, reports, now } = harness(facts)
    facts.nextDueAt = now() + DUE_HOLD_LEAD_MS + 60_000
    await activity.check()
    // Due later than the lead: the machine may pause; the control plane wakes it.
    expect(tasks).toEqual([])
    expect(reports).toEqual([{ busy: false, nextWakeAt: facts.nextDueAt }])
    facts.nextDueAt = now() + 5 * 60_000
    await activity.check()
    expect(tasks).toEqual(['PUT /v1/tasks/solus-work {"expire":600}'])
    expect(reports.at(-1)).toEqual({ busy: false, nextWakeAt: facts.nextDueAt })
  })

  test('a machine that is not managed neither holds nor reports', async () => {
    const { activity, tasks, reports } = harness({ busy: true, nextDueAt: 5 })
    await activity.check()
    expect(tasks).toEqual([])
    expect(reports).toEqual([])
  })
})
