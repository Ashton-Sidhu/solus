import { describe, expect, test } from 'bun:test'
import type { AppCallDetail, AppCallView, AppSignalOccurrence, AppSpan } from '@solus/contracts/apps'
import {
  CALL_FIRST_PAGE,
  CALL_FULL_PAGE,
  NEW_ACTIVITY_VIEW,
  activityFilterCount,
  activityViewOf,
  callAtPoint,
  callBarText,
  callBars,
  callChipText,
  callDurationText,
  callMessage,
  callQuery,
  callRunGroups,
  callTrendPoints,
  callZoomText,
  callsSummary,
  canShowMoreCalls,
  fieldValues,
  isActivityFiltered,
  orderedCalls,
  rememberActivityView,
  withChip,
} from '@solus/workspace-ui/components/app/manage/lib/activity'
import { appState, deliveryState, runState, stepState, versionState } from '@solus/workspace-ui/components/app/manage/lib/states'
import { activityEmptyTitle, appAddPrompt, emptyDescriptionParts, sectionErrorTitle, workflowsEmpty, WORKFLOWS_EMPTY } from '@solus/workspace-ui/components/app/manage/lib/section-empty'
import { callTraceView } from '@solus/workspace-ui/components/app/manage/lib/trace'
import { callSheetFacts, callSheetSummary, callsAround, neighbourCall } from '@solus/workspace-ui/components/app/manage/lib/call-sheet'
import {
  SIGNAL_ACTION_TYPES,
  SIGNAL_EMPTY_TEMPLATE_TEXT,
  SIGNAL_TEMPLATE_HELP,
  emptySignalActionDraft,
  signalActionDraftOf,
  signalActionOf,
} from '@solus/workspace-ui/components/app/manage/lib/signal-actions'
import { canRetryRun, canTerminateRun } from '@solus/workspace-ui/components/app/manage/lib/runs'
import { stepCodeRefusal } from '@solus/workspace-ui/components/app/manage/lib/run-graph'
import { appMemoryText, appRunState, appStateText, appStateTitle, appVersionText, failureRateText, hourBars, hourPoints, hourSpanStartLabel, hostFoldersText, madeText, nextScheduleRun, runtimeText, scheduleNextText, versionDetail } from '@solus/workspace-ui/components/app/manage/lib/overview'
import { operationGroups, operationInput, spanSummary } from '@solus/workspace-ui/components/app/manage/lib/operations'
import { uploadPercent, uploadRefusal } from '@solus/workspace-ui/components/app/manage/lib/app-file-transfer'
import { KEYBINDINGS } from '@solus/workspace-ui/lib/keybindings/manifest'
import { KeybindingsContext } from '@solus/workspace-ui/lib/keybindings/dispatcher.svelte'

// The Manage page of one app (docs/plans/apps.md §9.2). These are its rules, with no host.

describe('the query of the Activity section', () => {
  const now = Date.parse('2026-11-13T12:00:00Z')

  test('a drag across the chart zooms the query to that time, in place of the range', () => {
    // WHY: the zoom narrows what the host reads — the rows, the totals, and the bars — not only what the chart draws.
    const zoom = { from: now - 3 * 60 * 60 * 1000, to: now - 60 * 60 * 1000 }
    expect(callQuery({ ...NEW_ACTIVITY_VIEW, zoom }, now)).toEqual({ since: zoom.from, until: zoom.to, limit: CALL_FIRST_PAGE })
    expect(callQuery({ ...NEW_ACTIVITY_VIEW, range: 'all', zoom }, now).since).toBe(zoom.from)
    // The heading names the time; a zoom on another day names the day too.
    expect(callZoomText(zoom, now)).toMatch(/–/)
    expect(callZoomText({ from: now - 3 * 86_400_000, to: now - 2 * 86_400_000 }, now)).not.toBe(callZoomText(zoom, now))
  })

  test('the bars stack the failed calls on the calls that did not fail', () => {
    const bars = callBars({ buckets: [{ start: 10, calls: 5, failed: 2 }, { start: 20, calls: 0, failed: 0 }] })
    expect(bars).toEqual([{ at: 10, total: 5, ok: 3, failed: 2 }, { at: 20, total: 0, ok: 0, failed: 0 }])
    expect(callBarText(bars[0])).toBe('5 calls, 2 failed')
    expect(callBarText({ total: 1, failed: 0 })).toBe('1 call')
  })

  test('one log holds both kinds of call; the Model calls view narrows it to the model calls', () => {
    // WHY: the log is one list of events. A read without a kind is what gives the host's rows of
    // operations and of model calls together; a kind in every read would hide one of them.
    expect(callQuery(NEW_ACTIVITY_VIEW, now).kind).toBeUndefined()
    expect(callQuery({ ...NEW_ACTIVITY_VIEW, kind: 'model' }, now).kind).toBe('model')
    expect(isActivityFiltered({ ...NEW_ACTIVITY_VIEW, kind: 'model' })).toBe(true)
    // The Filters button counts the kind and the outcome it holds.
    expect(activityFilterCount({ kind: 'model', outcome: 'failed' })).toBe(2)
    expect(activityFilterCount(NEW_ACTIVITY_VIEW)).toBe(0)
  })

  test('a read asks the host for the range, and each filter as a group that must match', () => {
    // WHY: the host applies the query to the whole log. A chip and the outcome narrow
    // the query; they must not join an `or` group of the typed text.
    expect(callQuery(NEW_ACTIVITY_VIEW, now)).toEqual({ since: now - 24 * 60 * 60 * 1000, limit: CALL_FIRST_PAGE })
    const view = { ...NEW_ACTIVITY_VIEW, range: 'all', text: 'operation:save or caller:workflow', chips: [{ field: 'version', value: '14' }], outcome: 'failed' } as const
    expect(callQuery({ ...view, chips: [...view.chips] }, now, CALL_FULL_PAGE)).toEqual({
      limit: CALL_FULL_PAGE,
      match: [
        [{ field: 'operation', value: 'save' }, { field: 'caller', value: 'workflow' }],
        [{ field: 'version', value: '14' }],
        [{ field: 'outcome', value: 'failed' }],
      ],
    })
  })

  test('spaces alone are no query, and the same chip twice narrows nothing', () => {
    expect(callQuery({ ...NEW_ACTIVITY_VIEW, text: '   ' }, now).match).toBeUndefined()
    expect(isActivityFiltered({ ...NEW_ACTIVITY_VIEW, text: '   ' })).toBe(false)
    expect(isActivityFiltered({ ...NEW_ACTIVITY_VIEW, outcome: 'running' })).toBe(true)
    const chip = { field: 'caller', value: 'agent' } as const
    expect(withChip([chip], { ...chip })).toEqual([chip])
    // Filter out after filter for turns the chip over; it does not ask for a call that both is and is not.
    expect(withChip([chip], { ...chip, not: true })).toEqual([{ ...chip, not: true }])
  })

  test('a view that opens again shows the query it left, unless another section opened it on a filter', () => {
    // WHY: the Overview's failed calls and an operation's "Open in Activity" read the log with a
    // filter first; the section must open on that filter, not on the query it left before.
    const left = { ...NEW_ACTIVITY_VIEW, text: 'timeout', range: 'week' } as const
    rememberActivityView('host', 'app', { ...left, chips: [] })
    expect(activityViewOf('host', 'app', { kind: 'operation', limit: 100 })).toEqual({ ...left, chips: [] })
    expect(activityViewOf('host', 'app', { outcome: 'failed' })).toEqual({ ...NEW_ACTIVITY_VIEW, range: 'all', outcome: 'failed', chips: [] })
    expect(activityViewOf('host', 'app', { operation: 'save' }).chips).toEqual([{ field: 'operation', value: 'save' }])
    expect(activityViewOf('other', 'app', {})).toEqual(NEW_ACTIVITY_VIEW)
  })

  test('more calls are offered only when the read came back full and a larger read exists', () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index): Pick<AppCallView, 'id'> => ({ id: String(index) })) as AppCallView[]
    expect(canShowMoreCalls(rows(CALL_FIRST_PAGE), CALL_FIRST_PAGE)).toBe(true)
    expect(canShowMoreCalls(rows(CALL_FIRST_PAGE - 1), CALL_FIRST_PAGE)).toBe(false)
    expect(canShowMoreCalls(rows(CALL_FULL_PAGE), CALL_FULL_PAGE)).toBe(false)
  })

  test('a call with no end says that it runs, not that it took no time', () => {
    expect(callDurationText({ durationMs: null, outcome: 'running' })).toBe('Running')
    expect(callDurationText({ durationMs: 840, outcome: 'ok' })).toBe('840ms')
  })
})

describe('the trend and the rows of the Activity section', () => {
  const at = Date.parse('2026-11-13T12:00:00Z')
  const call = (id: string, patch: Partial<AppCallView> = {}): AppCallView => ({
    id, kind: 'operation', version: 1, operation: 'sync', caller: { kind: 'ui' }, startedAt: at, finishedAt: at + 40, outcome: 'ok', error: null,
    durationMs: 40, logCount: 0, spanCount: 0, traceId: null, spanId: null, ...patch,
  })

  test('the trend has a point for each call that ended, and a point opens the call it stands for', () => {
    // WHY: the reader sees an outlier in the chart and opens it. A point that opens
    // another call, or a running call drawn at no time, tells them something false.
    const calls = [call('a', { spanId: 'span-a', outcome: 'failed' }), call('b'), call('c', { durationMs: null, outcome: 'running', finishedAt: null })]
    const points = callTrendPoints(calls)
    expect(points.map((point) => [point.value, point.failed])).toEqual([[40, true], [40, false]])
    expect(points.map((point) => callAtPoint(calls, point)?.id)).toEqual(['a', 'b'])
  })

  test('the list keeps the order of the host, turns it over, or puts the slowest call first', () => {
    // WHY: the list has no column to sort by. The order menu is the only way to find the slow
    // call, and a call that still runs has no time, so it must not go above a call that took long.
    const calls = [call('new', { durationMs: 40 }), call('running', { durationMs: null, outcome: 'running' }), call('old', { durationMs: 900 })]
    expect(orderedCalls(calls, 'newest').map((entry) => entry.id)).toEqual(['new', 'running', 'old'])
    expect(orderedCalls(calls, 'oldest').map((entry) => entry.id)).toEqual(['old', 'running', 'new'])
    expect(orderedCalls(calls, 'slowest').map((entry) => entry.id)).toEqual(['old', 'new', 'running'])
    expect(calls.map((entry) => entry.id)).toEqual(['new', 'running', 'old'])
  })

  test('the band says how many calls are in view, that a full page is the newest ones, and how many failed', () => {
    expect(callsSummary([call('a')], 100)).toBe('1 call')
    expect(callsSummary([call('a'), call('b', { outcome: 'failed' })], 2)).toBe('The newest 2 calls · 1 failed')
  })

  test('a field shows its most common values in view, with their share, and a duration keeps its ranges in order', () => {
    // WHY: a value of the Fields list adds a filter; its share must be of every call in view.
    const calls = [call('a', { outcome: 'failed' }), call('b'), call('c'), call('d', { durationMs: 12_000 })]
    expect(fieldValues(calls, 'outcome')).toEqual([{ value: 'ok', count: 3, share: 0.75 }, { value: 'failed', count: 1, share: 0.25 }])
    expect(fieldValues(calls, 'duration').map((entry) => entry.value)).toEqual(['under 100 ms', '10 s or more'])
    expect(fieldValues(calls, 'run')).toEqual([])
  })

  test('grouped by run, the calls of one run stand together where the first of them stood', () => {
    const step = (runId: string) => ({ kind: 'workflow', runId, workflow: 'release', step: 'ask' }) as const
    const calls = [call('a', { caller: step('r1') }), call('b'), call('c', { caller: step('r2') }), call('d', { caller: step('r1') })]
    expect(callRunGroups(calls).map((group) => [group.runId, group.calls.map((entry) => entry.id)])).toEqual([['r1', ['a', 'd']], [null, ['b']], ['r2', ['c']]])
  })

  test('a row reads as an event: the error of a failed call, the work of a model call, and its fields as chips', () => {
    // WHY: the document column is how a reader scans the log; a field the call does not hold must not show as an empty chip.
    expect(callMessage(call('a', { outcome: 'failed', error: 'TimeoutError' }))).toBe('TimeoutError')
    expect(callMessage(call('m', { kind: 'model', caller: { kind: 'workflow', runId: 'r1', workflow: 'summarizeRelease', step: 'ask' } }))).toBe('model call in summarizeRelease')
    expect(callMessage(call('b', { logCount: 2, spanCount: 1 }))).toBe('2 log lines · 1 span')
    expect(callMessage(call('c'))).toBeNull()
    expect(callChipText(call('d', { caller: { kind: 'schedule', name: 'hourly' } }), 'caller')).toBe('Schedule')
    expect(callChipText(call('e'), 'run')).toBeNull()
    expect(callChipText(call('f', { durationMs: null, outcome: 'running' }), 'duration')).toBeNull()
  })
})

describe('the call sheet of the Activity section', () => {
  const at = Date.parse('2026-11-13T12:00:00Z')
  const call = (id: string, patch: Partial<AppCallView> = {}): AppCallView => ({
    id, kind: 'operation', version: 14, operation: 'summarizeRelease', caller: { kind: 'workflow', runId: 'run_8f2c', workflow: 'weekly-digest', step: 'ask-model' },
    startedAt: at, finishedAt: at + 30_000, outcome: 'failed', error: 'TimeoutError', durationMs: 30_000, logCount: 0, spanCount: 0, traceId: null, spanId: null, ...patch,
  })

  test('the key facts name the caller, the run and its step, the duration against the p95, and whether the version is live', () => {
    const facts = callSheetFacts(call('a'), 4100, 14, [])
    expect(facts.map((fact) => [fact.label, fact.value, fact.detail])).toEqual([
      ['Caller', 'Workflow', 'weekly-digest'],
      ['Run', 'run_8f2c', 'step ask-model'],
      ['Duration', '30.0s', 'p95 is 4.1s'],
      ['Version', '14', 'live'],
    ])
    // A call outside a run has no Run fact, and an old version is not called live.
    expect(callSheetFacts(call('b', { caller: { kind: 'ui' } }), null, 15, []).map((fact) => [fact.label, fact.detail])).toEqual([['Caller', null], ['Duration', null], ['Version', null]])
  })

  test('the head says how the call ended before when it started', () => {
    expect(callSheetSummary(call('a'))).toMatch(/^Failed after 30\.0s · /)
    expect(callSheetSummary(call('b', { outcome: 'running', durationMs: null }))).toMatch(/^Running · /)
  })

  test('j and k step through the calls in the order shown, and stop at either end', () => {
    // WHY: the sheet steps through the log the reader sees; a step past the end must not wrap to a call far away.
    const calls = ['a', 'b', 'c'].map((id) => call(id))
    expect(neighbourCall(calls, 'b', 1)?.id).toBe('c')
    expect(neighbourCall(calls, 'b', -1)?.id).toBe('a')
    expect(neighbourCall(calls, 'c', 1)).toBeNull()
    expect(neighbourCall(calls, 'x', 1)).toBeNull()
    expect(callsAround(calls, 'a', 1).map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})

describe('the trace of a call in the Insights waterfall', () => {
  const at = Date.parse('2026-11-13T12:00:00Z')
  const span = (startMs: number, durationMs: number, patch: Partial<AppSpan> = {}): AppSpan => ({ kind: 'fetch', name: 'GET api.example.com', startMs, durationMs, ok: true, ...patch })
  const detail = (spans: AppSpan[], patch: Partial<AppCallDetail> = {}): AppCallDetail => ({
    id: 'call-1', kind: 'operation', version: 1, operation: 'sync', caller: { kind: 'ui' }, startedAt: at, finishedAt: at + 200, outcome: 'ok', error: null,
    durationMs: 200, logCount: 0, spanCount: spans.length, traceId: null, spanId: null, input: null, inputTruncated: false, resultBytes: null,
    errorStack: null, logs: [], logsTruncated: false, spans, runId: null, ...patch,
  })

  test('the call is the root, named by its operation, and each span sits at its own time inside it', () => {
    // WHY: a span's times are from the start of the call. A span placed on the
    // wrong clock draws the call waiting where it did not.
    const view = callTraceView(detail([span(100, 50), span(0, 25, { kind: 'sql', name: '3 statements' })]))!
    expect(view.totalMs).toBe(200)
    expect(view.rows.map((row) => [row.label, row.depth, row.startOffsetMs, row.durationMs])).toEqual([
      ['sync', 0, 0, 200],
      ['3 statements', 1, 0, 25],
      ['GET api.example.com', 1, 100, 50],
    ])
    // A request and the SQL total keep different hues.
    expect(view.rows[1].color).not.toBe(view.rows[2].color)
  })

  test('a failed span reads as an error, and a call that still runs ends where its last span ends', () => {
    const view = callTraceView(detail([span(0, 100), span(100, 300, { ok: false, detail: '503' })], { durationMs: null, finishedAt: null, outcome: 'running' }))!
    expect(view.totalMs).toBe(400)
    expect(view.rows[2]).toMatchObject({ status: 'error' })
    expect(view.rows[2].span?.attrs.description).toBe('503')
  })

  test('a call that waited for nothing has no trace', () => {
    expect(callTraceView(detail([]))).toBeNull()
  })
})

describe('the Overview section', () => {
  test('each hour stacks its succeeded calls on its failed calls, and never draws a negative bar', () => {
    const points = hourPoints([{ start: 0, calls: 0, failed: 0 }, { start: 1, calls: 200, failed: 50 }, { start: 2, calls: 1, failed: 3 }])
    expect(points.map((point) => [point.failed, point.succeeded])).toEqual([[0, 0], [50, 150], [1, 0]])
  })

  test('the tallest bar is the busiest hour, and the failed part of a bar is its share of that hour', () => {
    // WHY: the bars compare the hours with each other. A bar drawn against a fixed scale, or a failed
    // part drawn against the whole day, says that a quiet hour was busy or that one failure was many.
    const bars = hourBars([{ start: 0, calls: 0, failed: 0 }, { start: 1, calls: 200, failed: 50 }, { start: 2, calls: 100, failed: 0 }])
    expect(bars.map((bar) => [bar.height, bar.failedPart])).toEqual([[0, 0], [1, 0.25], [0.5, 0]])
    expect(hourBars([{ start: 0, calls: 0, failed: 0 }]).map((bar) => bar.height)).toEqual([0])
  })

  test('the first label of the bars says yesterday only when that hour is on the day before', () => {
    const now = new Date(2026, 10, 15, 13, 30).getTime()
    expect(hourSpanStartLabel(new Date(2026, 10, 14, 14, 0).getTime(), now)).toMatch(/ yesterday$/)
    expect(hourSpanStartLabel(new Date(2026, 10, 15, 0, 0).getTime(), now)).not.toMatch(/yesterday/)
  })

  test('the failure rate has no number when nothing ran', () => {
    expect(failureRateText(0, 0)).toBe('—')
    expect(failureRateText(200, 0)).toBe('0%')
    expect(failureRateText(1000, 42)).toBe('4.2%')
    expect(failureRateText(10, 5)).toBe('50%')
  })

  test('stopped is the state of an app that the owner turned off, and a build shows over each other state', () => {
    expect(appRunState({ stopped: false, activeVersion: 2, buildingVersion: null })).toBe('running')
    expect(appRunState({ stopped: true, activeVersion: 2, buildingVersion: null })).toBe('stopped')
    expect(appRunState({ stopped: false, activeVersion: null, buildingVersion: null })).toBe('no-version')
    expect(appRunState({ stopped: false, activeVersion: null, buildingVersion: 1 })).toBe('building')
  })

  test('the state line says why a stopped or new app does nothing, and a build wins over every other state', () => {
    const runtime = { running: true, startedAt: 1, inFlight: 0, rssBytes: null }
    expect(appStateText({ stopped: true, activeVersion: 2 }, { number: 3 }, runtime)).toBe('The host builds version 3 now.')
    expect(appStateText({ stopped: false, activeVersion: null }, null, null)).toBe('Deploy a version to run the app.')
    expect(appStateText({ stopped: true, activeVersion: 2 }, null, runtime)).toBe('No operation runs and no schedule fires.')
    // WHY: before the host answers with the runner, the line must not claim the runner is idle.
    expect(appStateText({ stopped: false, activeVersion: 2 }, null, null)).toBe('Reading…')
  })

  test('a schedule says when it runs next, and a paused one never claims a next run', () => {
    const now = 1_000_000
    expect(scheduleNextText({ enabled: false, nextRunAt: now + 60_000 }, now)).toBe('Paused')
    expect(scheduleNextText({ enabled: true, nextRunAt: null }, now)).toBe('Not planned')
    expect(scheduleNextText({ enabled: true, nextRunAt: now + 2 * 60 * 60_000 }, now)).toMatch(/^Next in /)
  })

  test('a deploy names its message and who made it, and a failed one says why it did not start', () => {
    const agent = { kind: 'agent' as const, title: 'Fix the chart', sessionId: 's1' }
    expect(versionDetail({ message: 'Add the chart', state: 'active', error: null, createdBy: agent })).toBe('Add the chart · Fix the chart')
    expect(versionDetail({ message: '', state: 'superseded', error: null, createdBy: { kind: 'system' } })).toBe('By Solus')
    expect(versionDetail({ message: 'Add the chart', state: 'failed', error: 'Build failed.', createdBy: agent })).toBe('Did not start: Build failed.')
  })

  test('the status line names the version that runs and the host', () => {
    expect(appVersionText({ activeVersion: 14 }, null)).toBe('v14')
    expect(appVersionText({ activeVersion: null }, null)).toBe('No version')
    expect(appVersionText({ activeVersion: 14 }, { number: 15 })).toBe('v14 → v15')
    expect(appVersionText({ activeVersion: null }, { number: 1 })).toBe('v1')
  })

  test('the status line shows memory only for a process that runs', () => {
    // WHY: the memory of a process that stopped is not the memory the app uses now.
    expect(appMemoryText({ running: true, rssBytes: 47 * 1024 * 1024 })).toBe('47 MB')
    expect(appMemoryText({ running: false, rssBytes: 47 * 1024 * 1024 })).toBeNull()
    expect(appMemoryText({ running: true, rssBytes: null })).toBeNull()
    expect(appMemoryText(null)).toBeNull()
  })

  test('the words of the state mark agree with the mark', () => {
    // WHY: the mark is the only status on the line; its name must not say Running where the mark says idle or offline.
    const live = { stopped: false, activeVersion: 2, buildingVersion: null }
    const idle = { running: false, startedAt: null, inFlight: 0, rssBytes: null }
    const busy = { running: true, startedAt: 1, inFlight: 1, rssBytes: null }
    expect(appStateTitle(live, null, busy, false)).toBe('Running · 1 call in progress')
    expect(appStateTitle(live, null, idle, false)).toBe('Idle until the next call')
    expect(appStateTitle({ ...live, stopped: true }, null, idle, false)).toBe('Stopped · No operation runs and no schedule fires.')
    expect(appStateTitle(live, null, busy, true)).toBe('Offline · The host does not answer')
  })

  test('the next schedule is the first planned run of a schedule that runs', () => {
    // WHY: a paused schedule keeps its planned time. It must not show as the next thing the app does.
    const schedules = [
      { name: 'paused', enabled: false, nextRunAt: 10 },
      { name: 'later', enabled: true, nextRunAt: 300 },
      { name: 'unplanned', enabled: true, nextRunAt: null },
      { name: 'soon', enabled: true, nextRunAt: 200 },
    ]
    expect(nextScheduleRun(schedules)?.name).toBe('soon')
    expect(nextScheduleRun(schedules.slice(0, 1))).toBeNull()
  })

  test('the Made line counts the sessions only when the host named some', () => {
    const at = new Date(2026, 10, 3).getTime()
    expect(madeText(at, { kind: 'system' }, 4)).toMatch(/ by Solus, in 4 sessions$/)
    expect(madeText(at, { kind: 'system' }, 1)).toMatch(/, in 1 session$/)
    expect(madeText(at, { kind: 'system' }, undefined)).toMatch(/ by Solus$/)
    expect(madeText(at, { kind: 'system' }, 0)).toMatch(/ by Solus$/)
  })

  test('the host folders say what the app reads and writes, and "None" when it may touch none', () => {
    expect(hostFoldersText({ read: [], write: [] })).toBe('None')
    expect(hostFoldersText({ read: ['reports'], write: ['exports', 'cache'] })).toBe('Reads reports · Writes exports, cache')
    expect(hostFoldersText({ read: ['*'], write: [] })).toBe('Reads every file')
  })

  test('a runner with no process is idle, not broken', () => {
    // WHY: a runner stops after five idle minutes and starts for the next call (§6.2).
    expect(runtimeText({ running: false, startedAt: null, inFlight: 0, rssBytes: null })).toBe('Idle until the next call')
    expect(runtimeText({ running: true, startedAt: 1, inFlight: 2, rssBytes: 64 * 1024 * 1024 })).toBe('2 calls in progress · 64 MB')
    expect(runtimeText({ running: true, startedAt: 1, inFlight: 0, rssBytes: null })).toBe('No call in progress')
  })
})

describe('the Operations section', () => {
  test('the list puts the reads before the writes, and drops a group with no operation', () => {
    const operations = [{ name: 'add', kind: 'mutation' }, { name: 'list', kind: 'query' }, { name: 'get', kind: 'query' }] as const
    expect(operationGroups(operations).map((group) => [group.label, group.operations.map((operation) => operation.name)])).toEqual([['Reads', ['list', 'get']], ['Writes', ['add']]])
    expect(operationGroups([{ name: 'list', kind: 'query' }]).map((group) => group.label)).toEqual(['Reads'])
  })

  test('the line under a response counts what the call waited for, by kind and by host', () => {
    // WHY: the console says in one line what a run cost: the SQL is one span that counts its statements.
    const span = (kind: AppSpan['kind'], name: string): AppSpan => ({ kind, name, startMs: 0, durationMs: 1, ok: true })
    expect(spanSummary([span('sql', '2 statements'), span('fetch', 'GET api.github.com/repos/a')])).toBe('2 SQL statements and 1 request to api.github.com.')
    expect(spanSummary([span('fetch', 'GET https://a.dev/x'), span('fetch', 'POST a.dev'), span('tool', 'linear.list'), span('model', 'fast')])).toBe('2 requests to a.dev, 1 tool call, and 1 model call.')
    expect(spanSummary([])).toBe('The call waited for nothing outside its own code.')
  })
})

describe('the form that runs one operation', () => {
  test('the input is a JSON object, and nothing typed is an empty object', () => {
    expect(operationInput('  ')).toEqual({ ok: true, value: '{}' })
    expect(operationInput('{ "title": "Nightly" }')).toEqual({ ok: true, value: '{"title":"Nightly"}' })
    for (const text of ['[1, 2]', '"text"', '12', 'null']) expect(operationInput(text)).toEqual({ ok: false, error: 'The input must be a JSON object.' })
    expect(operationInput('{ title: }').ok).toBe(false)
  })
})

describe('an upload in the Files section', () => {
  test('progress is the share of bytes sent, and a file of no bytes is done', () => {
    expect(uploadPercent({ size: 1000, sentBytes: 250 })).toBe(25)
    expect(uploadPercent({ size: 1000, sentBytes: 5000 })).toBe(100)
    expect(uploadPercent({ size: 0, sentBytes: 0 })).toBe(100)
  })

  test('a file over the limit is refused before a byte is sent', () => {
    expect(uploadRefusal({ size: 64 * 1024 * 1024 })).toBeNull()
    expect(uploadRefusal({ size: 64 * 1024 * 1024 + 1 })).toContain('64 MiB')
  })
})

describe('the key that switches between the app and its Manage page', () => {
  // The dispatcher yields to text fields via `target instanceof HTMLElement`,
  // which the bun runtime has no DOM for; a bare stand-in reaches the scope scan.
  const globals = globalThis as { HTMLElement?: unknown }
  globals.HTMLElement ??= class {}

  const press = (code: string) =>
    ({ code, altKey: true, shiftKey: false, metaKey: false, ctrlKey: false, repeat: false, target: null, preventDefault: () => {} }) as unknown as KeyboardEvent

  test('answers only while an app surface has focus, and leaves the pane its own key', () => {
    // WHY: an app opens in a companion pane, where ⌥M maximizes the pane. A scope above
    // the global one that took ⌥M would take the pane's key in that pane.
    const combo = KEYBINDINGS['app-surface.toggle-manage'].combo
    expect(combo).toEqual({ alt: true, code: 'KeyG' })
    const kb = new KeybindingsContext()
    kb.pushScope('global')
    let toggled = 0
    let maximized = 0
    kb.register('app-surface.toggle-manage', () => { toggled += 1 })
    kb.register('pane.maximize', () => { maximized += 1 })

    kb.dispatch(press('KeyG'))
    expect(toggled).toBe(0)

    const leave = kb.pushScope('app-surface')
    kb.dispatch(press('KeyG'))
    kb.dispatch(press('KeyM'))
    expect([toggled, maximized]).toEqual([1, 1])
    leave()
    kb.dispatch(press('KeyG'))
    expect(toggled).toBe(1)
  })
})

describe('the mark that says how a thing stands', () => {
  test('a state that is not a fault never shows the mark of a failure', () => {
    // WHY: the mark is the only status signal of a row. A run the owner terminated, a version that
    // another one replaced, and a throttled action are not failures; red there sends the owner to a fault that is not one.
    expect(runState('terminated')).toBe('stopped')
    expect(runState('sleeping')).toBe('sleeping')
    expect(versionState('superseded')).toBe('idle')
    expect(deliveryState('throttled')).toBe('warning')
  })

  test('a thing that ended well and a thing that failed each have one mark, whatever the thing is', () => {
    expect([runState('succeeded'), stepState('done'), versionState('active'), deliveryState('delivered')]).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect([runState('failed'), stepState('failed'), versionState('failed'), deliveryState('failed')]).toEqual(['failed', 'failed', 'failed', 'failed'])
    // A build is the session mark of a start, not of work: the version does not serve calls yet.
    expect(versionState('building')).toBe('starting')
  })

  test('an app shows the working mark only while its backend has a process', () => {
    // WHY: the mark is the sidebar's mark of a working session. An app with no process, a stopped
    // app, and an app with no version do no work; the working mark there says that something runs.
    const live = { stopped: false, activeVersion: 2, buildingVersion: null }
    expect(appState(live, { running: true }, false)).toBe('running')
    expect(appState(live, { running: false }, false)).toBe('idle')
    expect(appState(live, null, false)).toBe('idle')
    expect(appState({ ...live, stopped: true }, { running: true }, false)).toBe('idle')
    expect(appState({ ...live, activeVersion: null }, null, false)).toBe('idle')
    expect(appState({ ...live, buildingVersion: 3 }, { running: true }, false)).toBe('starting')
  })

  test('an app on a host that does not answer shows the offline mark, whatever it last reported', () => {
    // WHY: a host that does not answer cannot say that the app runs; a working mark there is stale.
    expect(appState({ stopped: false, activeVersion: 2, buildingVersion: null }, { running: true }, true)).toBe('offline')
    expect(appState({ stopped: false, activeVersion: 2, buildingVersion: 3 }, null, true)).toBe('offline')
  })
})

describe('the Code button of a workflow step', () => {
  test('it opens only when the host found the step in the source, and says why not otherwise', () => {
    // WHY: a disabled button with no reason is a dead end; the reason names the version the run ran.
    const source = { version: 14, path: 'src/app.ts', line: 42, column: 5, text: '' }
    expect(stepCodeRefusal('ask-model', 14, source, null)).toBeNull()
    expect(stepCodeRefusal('ask-model', 14, undefined, null)).toBe('Finding the step in the source…')
    expect(stepCodeRefusal('ask-model', 14, null, null)).toBe("The source of version 14 has no step.do('ask-model') call.")
    expect(stepCodeRefusal('ask-model', null, null, null)).toBe("The source of the active version has no step.do('ask-model') call.")
    expect(stepCodeRefusal('ask-model', 14, undefined, 'The host did not answer.')).toBe('The source was not read: The host did not answer.')
  })
})

describe('the empty state of a Manage section', () => {
  test('a filter that hides every run shows no medallion and offers to clear it', () => {
    // WHY: a filter miss is not a blank slate. The medallion and "add one" there send the owner to make a workflow that exists.
    let cleared = false
    const filtered = workflowsEmpty(true, true, () => (cleared = true))
    expect(filtered.icon).toBeUndefined()
    const clear = filtered.actions?.[0]
    expect(clear && 'run' in clear).toBe(true)
    if (clear && 'run' in clear) clear.run()
    expect(cleared).toBe(true)
  })

  test('an app that declares workflows but ran none does not ask for a new workflow', () => {
    expect(workflowsEmpty(false, true, () => {}).actions).toBeUndefined()
    expect(workflowsEmpty(false, false, () => {})).toBe(WORKFLOWS_EMPTY)
  })

  test('a part of the description in backticks is code', () => {
    expect(emptyDescriptionParts('Declare one in `app.ts` to keep a key out.')).toEqual([
      { text: 'Declare one in ', isCode: false },
      { text: 'app.ts', isCode: true },
      { text: ' to keep a key out.', isCode: false },
    ])
  })

  test('an empty Activity log names the range it looked in, because the range is why it is empty', () => {
    expect(activityEmptyTitle('hour')).toBe('No calls in the last hour')
    expect(activityEmptyTitle('day')).toBe('No calls in the last 24 hours')
    expect(activityEmptyTitle('week')).toBe('No calls in the last 7 days')
    expect(activityEmptyTitle('all')).toBe('No calls yet')
  })

  test('a failed read names the host only when the host does not answer', () => {
    // WHY: "did not answer" for a host that answered with an error sends the owner to check a host that is up.
    expect(sectionErrorTitle('studio-mini', true)).toBe('studio-mini did not answer')
    expect(sectionErrorTitle('studio-mini', false)).toBe('This section did not load')
  })

  test('the prompt that asks an agent to add a thing names the app and the app tools', () => {
    expect(appAddPrompt({ name: 'Query Watch', slug: 'query-watch' }, 'a schedule')).toBe(
      'Add a schedule to the app Query Watch (query-watch). Change it with checkout_app, save_app, and deploy_app.',
    )
  })
})
