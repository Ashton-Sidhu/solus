import { describe, expect, test } from 'bun:test'
import type { AppCallView, AppRevisionView, AppSignalOccurrence, AppSpan, AppVersionView } from '@solus/contracts/apps'
import {
  CALL_FIRST_PAGE,
  CALL_FULL_PAGE,
  NO_CALL_FILTER,
  callDurationText,
  callFilterOf,
  callQuery,
  canShowMoreCalls,
  isCallFilterSet,
  operationChoices,
} from '@solus/workspace-ui/components/app/manage/lib/activity'
import { traceWaterfall } from '@solus/workspace-ui/components/app/manage/lib/trace'
import { appTimeline, buildingVersion, canActivate } from '@solus/workspace-ui/components/app/manage/lib/timeline'
import {
  SIGNAL_ACTION_TYPES,
  SIGNAL_EMPTY_TEMPLATE_TEXT,
  SIGNAL_TEMPLATE_HELP,
  deliveryText,
  emptySignalActionDraft,
  occurrencesOf,
  signalActionDraftOf,
  signalActionOf,
} from '@solus/workspace-ui/components/app/manage/lib/signal-actions'
import { canRetryRun, canTerminateRun } from '@solus/workspace-ui/components/app/manage/lib/runs'
import { appRunState, failureRateText, hourBars, runtimeText } from '@solus/workspace-ui/components/app/manage/lib/overview'
import { operationInput } from '@solus/workspace-ui/components/app/manage/lib/operations'
import { uploadPercent, uploadRefusal } from '@solus/workspace-ui/components/app/manage/lib/app-file-transfer'
import { KEYBINDINGS } from '@solus/workspace-ui/lib/keybindings/manifest'
import { KeybindingsContext } from '@solus/workspace-ui/lib/keybindings/dispatcher.svelte'

// The Manage page of one app (docs/plans/apps.md §9.2). These are its rules, with no host.

describe('the filters of the Activity section', () => {
  test('a read asks the host only for the filters the person chose', () => {
    // WHY: the host applies the filters. An empty choice that goes to the host as a value finds no call.
    expect(callQuery(NO_CALL_FILTER)).toEqual({ limit: CALL_FIRST_PAGE })
    expect(callQuery({ operation: 'save', callerKind: '', outcome: 'failed' })).toEqual({ limit: CALL_FIRST_PAGE, operation: 'save', outcome: 'failed' })
    expect(callQuery({ operation: '', callerKind: 'workflow', outcome: '' }, CALL_FULL_PAGE)).toEqual({ limit: CALL_FULL_PAGE, callerKind: 'workflow' })
  })

  test('a view that opens again shows the filters of the list it left', () => {
    const filter = { operation: 'save', callerKind: 'schedule', outcome: 'failed' } as const
    expect(callFilterOf(callQuery(filter))).toEqual(filter)
    expect(callFilterOf({})).toEqual(NO_CALL_FILTER)
    expect(isCallFilterSet(NO_CALL_FILTER)).toBe(false)
    expect(isCallFilterSet({ ...NO_CALL_FILTER, outcome: 'running' })).toBe(true)
  })

  test('the operation filter offers what the version declares, then what the log still holds, then the chosen one', () => {
    // WHY: the log keeps calls of an operation that a newer version removed. The person must
    // still find them, and a chosen filter must not vanish from its own menu.
    const values = (declared: string[], seen: string[], chosen: string) => operationChoices(declared, seen, chosen).map((choice) => choice.value)
    expect(values(['list', 'save'], ['save', 'removedOp', 'build'], '')).toEqual(['', 'list', 'save', 'build', 'removedOp'])
    expect(values(['list'], [], 'gone')).toEqual(['', 'list', 'gone'])
    expect(operationChoices([], [], '')[0]).toEqual({ value: '', label: 'All operations' })
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

describe('the trace of a call as a waterfall', () => {
  const span = (startMs: number, durationMs: number, patch: Partial<AppSpan> = {}): AppSpan => ({ kind: 'fetch', name: 'GET api.example.com', startMs, durationMs, ok: true, ...patch })

  test('each span is a bar at its start, as wide as its time, on the time line of the call', () => {
    const { totalMs, rows } = traceWaterfall([span(100, 50), span(0, 25)], 200)
    expect(totalMs).toBe(200)
    // The earliest span is first, whatever order the host kept them in.
    expect(rows.map((row) => [row.leftPercent, row.widthPercent])).toEqual([[0, 12.5], [50, 25]])
  })

  test('a call that still runs has no time: the line ends where the last span ends', () => {
    const { totalMs, rows } = traceWaterfall([span(0, 100), span(100, 300)], null)
    expect(totalMs).toBe(400)
    expect(rows[1]).toMatchObject({ leftPercent: 25, widthPercent: 75 })
  })

  test('a span that ends after the time the host recorded does not leave the line', () => {
    const { totalMs, rows } = traceWaterfall([span(90, 60)], 100)
    expect(totalMs).toBe(150)
    for (const row of rows) expect(row.leftPercent + row.widthPercent).toBeLessThanOrEqual(100)
  })

  test('a span of no time still shows, and stays on the line at its end', () => {
    const { rows } = traceWaterfall([span(0, 0), span(1000, 0)], 1000)
    for (const row of rows) {
      expect(row.widthPercent).toBeGreaterThan(0)
      expect(row.leftPercent + row.widthPercent).toBeLessThanOrEqual(100)
    }
    expect(traceWaterfall([], null)).toEqual({ totalMs: 1, rows: [] })
  })
})

describe('the timeline of the Versions section', () => {
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)
  const C = 'c'.repeat(40)
  const revision = (commit: string, savedAt: number, versions: number[] = []): AppRevisionView => ({ commit, message: `save ${commit[0]}`, savedAt, versions })
  const version = (number: number, revisionCommit: string, state: AppVersionView['state'], patch: Partial<AppVersionView> = {}): AppVersionView => ({
    number, state, error: null, message: `deploy ${number}`, createdAt: number * 10, createdBy: { kind: 'system' }, permissionsNotice: null,
    operationCount: 1, hasUi: true, revision: revisionCommit, protocol: 3, buildMs: 100, ...patch,
  })

  test('the revisions and the versions are one list: each revision with the versions built from it, the newest first', () => {
    const timeline = appTimeline(
      [revision(A, 100, [1]), revision(C, 300), revision(B, 200, [2, 3])],
      [version(1, A, 'superseded'), version(2, B, 'failed'), version(3, B, 'active')],
    )
    expect(timeline.map((entry) => [entry.commit[0], entry.versions.map((built) => built.number)])).toEqual([['c', []], ['b', [3, 2]], ['a', [1]]])
    expect(timeline.map((entry) => entry.isNewest)).toEqual([true, false, false])
  })

  test('a revision can be deployed when it has no version, or when each build of it failed', () => {
    // WHY: a save and a deploy are two acts. A revision whose build works needs "Make active", not a second build.
    const timeline = appTimeline(
      [revision(A, 100), revision(B, 200), revision(C, 300)],
      [version(1, A, 'superseded'), version(2, B, 'failed'), version(3, B, 'failed')],
    )
    const canDeploy = Object.fromEntries(timeline.map((entry) => [entry.commit[0], entry.canDeploy]))
    expect(canDeploy).toEqual({ a: false, b: true, c: true })
    expect(canActivate(version(1, A, 'superseded'))).toBe(true)
    for (const state of ['building', 'active', 'failed'] as const) expect(canActivate(version(1, A, state))).toBe(false)
  })

  test('a revision that the host builds now is not deployed a second time', () => {
    const versions = [version(4, C, 'building', { buildMs: null })]
    expect(appTimeline([revision(C, 300)], versions)[0]?.canDeploy).toBe(false)
    expect(buildingVersion(versions)?.number).toBe(4)
    expect(buildingVersion([version(1, A, 'active')])).toBeNull()
  })

  test('a version whose revision the host did not list keeps its place, and is not offered for a deploy', () => {
    const timeline = appTimeline([revision(B, 200)], [version(1, A, 'failed', { createdAt: 50 }), version(2, B, 'active')])
    expect(timeline.map((entry) => [entry.commit[0], entry.isListed, entry.canDeploy])).toEqual([['b', true, false], ['a', false, false]])
    expect(timeline[1]?.message).toBe('deploy 1')
  })
})

describe('a signal action', () => {
  test('a signal has three types of action, and none of them starts a session by itself', () => {
    // WHY: a signal that must start a new session runs an automation, which holds the agent, the model, and the folder.
    expect([...SIGNAL_ACTION_TYPES]).toEqual(['notify', 'send_to_session', 'run_automation'])
  })

  test('only the fields of the chosen type go to the host', () => {
    const draft = { ...emptySignalActionDraft('notify'), title: ' {{payload.title}} is ready ', detail: 'From {{app}}', template: 'left from another type', sessionId: 's1' }
    expect(signalActionOf(draft)).toEqual({ ok: true, value: { type: 'notify', title: '{{payload.title}} is ready', detail: 'From {{app}}' } })
    expect(signalActionOf({ ...draft, type: 'send_to_session' })).toEqual({ ok: true, value: { type: 'send_to_session', template: 'left from another type', sessionId: 's1' } })
  })

  test('an action that names no session or no automation is refused before it reaches the host', () => {
    expect(signalActionOf(emptySignalActionDraft('send_to_session'))).toEqual({ ok: false, error: 'Give the ID of the session.' })
    expect(signalActionOf(emptySignalActionDraft('run_automation'))).toEqual({ ok: false, error: 'Choose an automation.' })
    // An empty template is not a refusal: it gives the signal and its payload.
    expect(signalActionOf({ ...emptySignalActionDraft('run_automation'), automationId: 'a1' })).toEqual({ ok: true, value: { type: 'run_automation', template: '', automationId: 'a1' } })
    expect(SIGNAL_EMPTY_TEMPLATE_TEXT).toContain('empty template')
  })

  test('the draft of a saved action holds what the host holds', () => {
    const view = { enabled: false, action: { type: 'run_automation', template: 'Check {{payload.id}}', automationId: 'a1' } } as const
    expect(signalActionDraftOf(view)).toMatchObject({ type: 'run_automation', enabled: false, template: 'Check {{payload.id}}', automationId: 'a1' })
    expect(signalActionOf(signalActionDraftOf(view))).toEqual({ ok: true, value: view.action })
  })

  test('the help under a template names each value a template takes', () => {
    for (const value of ['{{payload.path}}', '{{payload}}', '{{signal}}', '{{app}}']) expect(SIGNAL_TEMPLATE_HELP).toContain(value)
  })

  test('an occurrence says how each action ended, and a signal shows its own newest ones', () => {
    expect(deliveryText({ actionId: 'x', type: 'run_automation', status: 'throttled', detail: null })).toBe('Run an automation · Over the limit')
    const occurrence = (id: string, name: string, emittedAt: number): AppSignalOccurrence => ({ id, name, payload: '{}', emittedAt, callId: null, runId: null, deliveries: [] })
    const all = [occurrence('1', 'report.ready', 10), occurrence('2', 'report.failed', 20), occurrence('3', 'report.ready', 30), occurrence('4', 'report.ready', 20)]
    expect(occurrencesOf(all, 'report.ready', 2).map((entry) => entry.id)).toEqual(['3', '4'])
  })
})

describe('a run of a workflow', () => {
  test('the owner terminates a run that has not ended, and starts only a failed run again', () => {
    // WHY: each way in has its way back (§9.3): terminate, and run again.
    const allowed = (['running', 'sleeping', 'succeeded', 'failed', 'terminated'] as const).map((state) => [state, canTerminateRun({ state }), canRetryRun({ state })])
    expect(allowed).toEqual([
      ['running', true, false],
      ['sleeping', true, false],
      ['succeeded', false, false],
      ['failed', false, true],
      ['terminated', false, false],
    ])
  })
})

describe('the Overview section', () => {
  test('the tallest hour is all of the height, and an hour with one call still shows', () => {
    const bars = hourBars([{ start: 0, calls: 0, failed: 0 }, { start: 1, calls: 1, failed: 1 }, { start: 2, calls: 200, failed: 50 }])
    expect(bars.map((bar) => bar.heightPercent)).toEqual([0, 4, 100])
    // The failed part is its share of the bar.
    expect(bars.map((bar) => bar.failedPercent)).toEqual([0, 4, 25])
    expect(hourBars([{ start: 0, calls: 0, failed: 0 }])[0]?.heightPercent).toBe(0)
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

  test('a runner with no process is idle, not broken', () => {
    // WHY: a runner stops after five idle minutes and starts for the next call (§6.2).
    expect(runtimeText({ running: false, startedAt: null, inFlight: 0, rssBytes: null })).toContain('idle')
    expect(runtimeText({ running: true, startedAt: 1, inFlight: 2, rssBytes: 64 * 1024 * 1024 })).toBe('The runner has a process: 2 calls or runs in progress, 64 MB of memory.')
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
