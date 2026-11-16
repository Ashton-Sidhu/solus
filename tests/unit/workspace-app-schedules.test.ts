import { describe, expect, test } from 'bun:test'
import type { AppCallView, AppScheduleView } from '@solus/contracts/apps'
import {
  scheduleLastRunLine,
  scheduleNextRunText,
  scheduleRunSummary,
  scheduleRuns,
} from '@solus/workspace-ui/components/app/manage/lib/schedules'

const MINUTE = 60_000
const NOW = new Date(2026, 10, 11, 12).getTime()

const schedule = (patch: Partial<AppScheduleView> = {}): AppScheduleView => ({
  name: 'sync',
  trigger: { type: 'interval', everyMinutes: 10 },
  run: 'sync',
  enabled: true,
  nextRunAt: NOW + 8 * MINUTE,
  lastRunAt: NOW - 2 * MINUTE,
  lastOutcome: 'ok',
  lastError: null,
  ...patch,
})

let callCount = 0
const call = (name: string, outcome: AppCallView['outcome'] = 'ok', error: string | null = null): AppCallView => ({
  id: `call_${++callCount}`,
  version: 1,
  operation: 'sync',
  caller: { kind: 'schedule', name },
  startedAt: NOW - callCount * MINUTE,
  finishedAt: outcome === 'running' ? null : NOW - callCount * MINUTE + 1200,
  outcome,
  error,
  durationMs: outcome === 'running' ? null : 1200,
  logCount: 0,
  spanCount: 0,
  traceId: null,
  spanId: null,
})

describe('app schedules', () => {
  test('a schedule that cannot fire promises no next run time', () => {
    // WHY: a next run time on a schedule that cannot fire is a lie.
    expect(scheduleNextRunText(schedule(), false, NOW)).toStartWith('in 8 min · Today at')
    expect(scheduleNextRunText(schedule({ enabled: false }), false, NOW)).toBe('Paused')
    expect(scheduleNextRunText(schedule(), true, NOW)).toBe('When the app starts')
    expect(scheduleNextRunText(schedule({ nextRunAt: null }), false, NOW)).toBe('Not planned')
    expect(scheduleNextRunText(schedule({ nextRunAt: NOW - MINUTE }), false, NOW)).toBe('Due now')
  })

  test('the last run says how it ended, and a schedule that never ran says so', () => {
    expect(scheduleLastRunLine(schedule(), NOW)).toMatch(/^The last run ended well, /)
    expect(scheduleLastRunLine(schedule({ lastOutcome: 'failed', lastError: 'The secret database is not set.' }), NOW)).toContain('The secret database is not set. A failed run does not try again')
    expect(scheduleLastRunLine(schedule({ lastRunAt: null, lastOutcome: null }), NOW)).toBe('No run yet.')
  })

  test('the runs of a schedule are its own, the newest first', () => {
    const newest = call('sync')
    const other = call('digest')
    const older = call('sync', 'failed')
    const oldest = call('sync')
    expect(scheduleRuns([newest, other, older, oldest], 'sync', 2).map((run) => run.id)).toEqual([newest.id, older.id])
  })

  test("a failed run's error takes its history line", () => {
    expect(scheduleRunSummary(call('sync', 'failed', 'The secret database is not set.\n  at sync'))).toBe('The secret database is not set.')
    expect(scheduleRunSummary(call('sync'))).toBe('OK · 1.2s')
  })
})
