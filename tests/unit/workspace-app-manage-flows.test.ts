import { describe, expect, test } from 'bun:test'
import type { AppDeployPreflight, AppScheduleSpan, AppStepView } from '@solus/contracts/apps'
import type { AppChangeLogEntry } from '@solus/client-core/app-versions'
import { focusStep, notRunText, retryPolicyText, runGraph, runTimeline, stepNodeText, stepPolicyLine, tryRows } from '@solus/workspace-ui/components/app/manage/lib/run-graph'
import { RUN_TRIGGER_NODE_ID, runFlow, runStepNodeId } from '@solus/workspace-ui/components/app/manage/lib/run-flow'
import { canvasTakesTouch } from '@solus/workspace-ui/components/app/manage/lib/flow'
import { failedStepName, workflowNames } from '@solus/workspace-ui/components/app/manage/lib/runs'
import { calendarCell, calendarColumns, calendarEdges, calendarLane, triggerParts } from '@solus/workspace-ui/components/app/manage/lib/schedule-calendar'
import { scheduleLastRunLine } from '@solus/workspace-ui/components/app/manage/lib/schedules'
import { buildErrorPlace, historyMeta, historyState, missingSecretsTail, preflightBuildError, preflightLines } from '@solus/workspace-ui/components/app/manage/lib/versions'

/**
 * The Workflows, Schedules, and Versions sections of the Manage page
 * (docs/plans/apps.md §9.2): the run graph, the calendar, and the history.
 */

const step = (name: string, startedAt: number, finishedAt: number | null, overrides: Partial<AppStepView> = {}): AppStepView => ({
  name, kind: 'do', state: 'done', attempts: 1, startedAt, finishedAt, wakeAt: null, error: null, result: null, resultTruncated: false, tries: [], retryPolicy: null, ...overrides,
})

describe('the graph of a run', () => {
  test('steps that ran at the same time are one layer, and a run that failed shows the steps a good run did after it, not run', () => {
    // WHY: a workflow declares no step. The graph must still show what ran
    // in parallel, and what the failure kept from running.
    const run = { state: 'failed' as const, steps: [step('fetch', 0, 300), step('load', 10, 14), step('ask', 400, 900, { state: 'failed', attempts: 3 })] }
    const lastGood = { steps: [step('fetch', 0, 300), step('load', 10, 14), step('ask', 400, 500), step('store', 600, 700)] }
    const graph = runGraph(run, lastGood)
    expect(graph.layers.map((layer) => layer.map((entry) => [entry.name, entry.step === null]))).toEqual([
      [['fetch', false], ['load', false]],
      [['ask', false]],
      [['store', true]],
    ])
    expect(focusStep(graph)).toBe('ask')
    // A run that succeeded shows only its own steps.
    expect(runGraph({ ...run, state: 'succeeded' }, lastGood).steps.map((entry) => entry.name)).toEqual(['fetch', 'load', 'ask'])
  })

  describe('on the canvas', () => {
    const run = { state: 'failed' as const, steps: [step('fetch', 0, 300), step('load', 10, 14), step('ask', 400, 900, { state: 'failed', attempts: 3 })] }
    const lastGood = { steps: [step('fetch', 0, 300), step('load', 10, 14), step('ask', 400, 500), step('store', 600, 700), step('notify', 800, 900)] }
    const trigger = { caller: { kind: 'webhook' as const, webhookId: 'hook' }, name: 'github-release', detail: 'Webhook · 14:01:41' }

    test('the trigger is on top and each layer is a row under it, centered, the same each time', () => {
      // WHY: the layout comes from the step order alone; a run must draw the same way on every load and every client.
      const flow = runFlow(runGraph(run, lastGood), trigger)
      expect(flow.nodes.map((node) => [node.id, node.position.x, node.position.y])).toEqual([
        [RUN_TRIGGER_NODE_ID, 0, 0],
        [runStepNodeId('fetch'), -120, 92], [runStepNodeId('load'), 120, 92],
        [runStepNodeId('ask'), 0, 184],
        [runStepNodeId('store'), 0, 276],
        [runStepNodeId('notify'), 0, 368],
      ])
      expect(runFlow(runGraph(run, lastGood), trigger)).toEqual(flow)
      // The canvas is read-only: no node moves, connects, or takes a selection of its own.
      for (const node of flow.nodes) expect([node.draggable, node.connectable, node.selectable]).toEqual([false, false, false])
    })

    test('the failed step and the steps that did not run are their own kind of node, reached by dashed edges', () => {
      const flow = runFlow(runGraph(run, lastGood), trigger)
      expect(flow.nodes.map((node) => (node.data.kind === 'step' ? [node.id, node.data.state] : [node.id, node.data.kind]))).toEqual([
        [RUN_TRIGGER_NODE_ID, 'trigger'],
        [runStepNodeId('fetch'), 'done'], [runStepNodeId('load'), 'done'],
        [runStepNodeId('ask'), 'failed'],
        [runStepNodeId('store'), 'not-run'],
        [runStepNodeId('notify'), 'not-run'],
      ])
      // The trigger joins both steps of the first layer; a step that did not run is reached by a dashed edge.
      expect(flow.edges.map((edge) => [edge.source, edge.target, edge.style !== undefined])).toEqual([
        [RUN_TRIGGER_NODE_ID, runStepNodeId('fetch'), false], [RUN_TRIGGER_NODE_ID, runStepNodeId('load'), false],
        [runStepNodeId('fetch'), runStepNodeId('ask'), false], [runStepNodeId('load'), runStepNodeId('ask'), false],
        [runStepNodeId('ask'), runStepNodeId('store'), true],
        [runStepNodeId('store'), runStepNodeId('notify'), true],
      ])
    })

    test('on a touch device one finger scrolls the page and two fingers move the canvas; a mouse moves it as before', () => {
      // WHY: the canvas fills most of a phone's height. If it took every touch, the page under it could not be scrolled.
      expect(canvasTakesTouch(1, true)).toBe(false)
      expect(canvasTakesTouch(2, true)).toBe(true)
      expect(canvasTakesTouch(3, true)).toBe(true)
      // Not a touch device (a touch laptop with a trackpad): a touch drag pans the canvas, as a mouse drag does.
      expect(canvasTakesTouch(1, false)).toBe(true)
    })

    test('a step named "trigger" does not take the trigger node\'s place', () => {
      const flow = runFlow(runGraph({ state: 'succeeded', steps: [step('trigger', 0, 10)] }, null), trigger)
      expect(new Set(flow.nodes.map((node) => node.id)).size).toBe(2)
    })
  })

  test('the inspector says the retry options and each try, and the try that ended the step is the failure', () => {
    expect(retryPolicyText({ limit: 3, delayMs: 2000, backoff: 'exponential', timeoutMs: 30_000 })).toBe('3 retries, backoff from 2 s, 30 s limit')
    expect(retryPolicyText({ limit: 0, delayMs: 1000, backoff: 'constant', timeoutMs: 300_000 })).toBe('No retry, 300 s limit')
    expect(retryPolicyText({ limit: 1, delayMs: 500, backoff: 'constant', timeoutMs: 1000 })).toBe('1 retry, 500ms apart, 1 s limit')
    const failed = step('ask', 0, 3000, {
      state: 'failed', attempts: 2,
      tries: [{ attempt: 1, startedAt: 0, durationMs: 1000, ok: false, error: 'timed out' }, { attempt: 2, startedAt: 2000, durationMs: 1000, ok: false, error: 'timed out' }],
    })
    expect(tryRows(failed).map((row) => [row.label, row.detail, row.isFinal])).toEqual([['Try 1', 'timed out · 1.0s', false], ['Try 2', 'timed out · 1.0s', true]])
    // A step whose tries the log does not keep still says how it ended.
    expect(tryRows(step('save', 0, 40, { kind: 'mutation' }))).toEqual([{ label: 'Try 1', detail: 'done · 40ms', isFailure: false, isFinal: false }])
  })

  test('the timeline puts each try on the run\'s axis, with the wait between two tries', () => {
    const failed = step('ask', 0, 3000, {
      state: 'failed',
      tries: [{ attempt: 1, startedAt: 1000, durationMs: 1000, ok: false, error: 'x' }, { attempt: 2, startedAt: 3000, durationMs: 1000, ok: false, error: 'x' }],
    })
    const timeline = runTimeline({ startedAt: 0, finishedAt: 4000, steps: [failed] })
    expect(timeline.lanes[0].bars.map((bar) => [bar.left, bar.width, bar.tone])).toEqual([[25, 25, 'failed'], [75, 25, 'final']])
    expect(timeline.lanes[0].gaps).toEqual([{ key: 'ask:gap:0', left: 50, width: 25 }])
  })

  describe('a step with no tries data, as a host older than the field sends it', () => {
    // WHY: the user's host answered a run with no `tries` and no `retryPolicy`,
    // and the inspector threw. A step from such a host must still show how it ended.
    const old = (name: string, overrides: Partial<AppStepView>): AppStepView => {
      const { tries: _tries, retryPolicy: _retryPolicy, ...view } = step(name, 0, 2000, overrides)
      return view
    }

    test('a step that ended well', () => {
      const done = old('fetch', {})
      expect(tryRows(done)).toEqual([{ label: 'Try 1', detail: 'done · 2.0s', isFailure: false, isFinal: false }])
      expect(stepPolicyLine(done)).toBe('Step')
      expect(runTimeline({ startedAt: 0, finishedAt: 2000, steps: [done] }).lanes[0].bars).toEqual([{ key: 'fetch:0', left: 0, width: 100, tone: 'ok' }])
    })

    test('a step that failed after three tries', () => {
      const failed = old('ask', { state: 'failed', attempts: 3, error: 'timed out' })
      expect(tryRows(failed)).toEqual([{ label: 'Try 3', detail: 'failed · 2.0s', isFailure: true, isFinal: true }])
      expect(runTimeline({ startedAt: 0, finishedAt: 2000, steps: [failed] }).lanes[0].bars[0].tone).toBe('final')
    })

    test('a step of a run that is still working', () => {
      const running = old('ask', { state: 'running', finishedAt: null })
      expect(tryRows(running, 1500)).toEqual([{ label: 'Try 1', detail: 'running · 1.5s', isFailure: false, isFinal: false }])
      expect(runTimeline({ startedAt: 0, finishedAt: null, steps: [running] }, 1500).lanes[0].bars[0].tone).toBe('running')
    })

    test('a step of a kind that has no tries', () => {
      const mutation = old('save', { kind: 'mutation' })
      expect(tryRows(mutation)[0].detail).toBe('done · 2.0s')
      expect(stepPolicyLine(mutation)).toBe('Mutation')
    })

    test('a step that did not run in this run', () => {
      // The graph has no receipt for it: the node and the inspector say so, from the newest good run's receipt.
      const graph = runGraph({ state: 'failed', steps: [old('ask', { state: 'failed' })] }, { steps: [old('ask', {}), old('store', {})] })
      const notRun = graph.steps.find((entry) => entry.name === 'store')
      expect(notRun?.step).toBeNull()
      expect(notRun && stepNodeText(notRun)).toBe('Not run')
      expect(notRunText(old('store', {}))).toBe('This run did not reach this step. In the newest run that succeeded, it took 2.0s.')
    })
  })

  test('Retry names the step it runs again, and the picker keeps a workflow that only an older version ran', () => {
    expect(failedStepName({ state: 'failed', steps: [step('a', 0, 1), step('b', 1, 2, { state: 'failed' })] })).toBe('b')
    expect(failedStepName({ state: 'succeeded', steps: [step('a', 0, 1)] })).toBeNull()
    expect(workflowNames([{ name: 'digest' }], [{ workflow: 'old' }, { workflow: 'digest' }])).toEqual(['digest', 'old'])
  })
})

describe('the calendar of the schedules', () => {
  const span = (overrides: Partial<AppScheduleSpan> = {}): AppScheduleSpan => ({ ok: 0, failed: 0, running: 0, planned: 0, lastRunAt: null, lastOutcome: null, ...overrides })
  const day = 24 * 60 * 60_000

  test('a week starts on Monday in the client\'s own time, and a day has twenty-four hours', () => {
    const sunday = new Date(2026, 10, 15, 13, 30).getTime()
    const week = calendarEdges('week', sunday)
    expect(week).toHaveLength(8)
    expect(new Date(week[0]).getDay()).toBe(1)
    expect(new Date(week[0]).getDate()).toBe(9)
    expect(calendarEdges('day', sunday)).toHaveLength(25)
  })

  test('a cell says the time of its one run, the count of many, the runs a trigger planned that did not run, and the next run', () => {
    // WHY: a day with no run is a fact the owner must see; a day to come is not a missed day.
    const column = { start: 0, end: day }
    const lane = { upcoming: [3 * day + 9 * 60 * 60_000] }
    const on = { enabled: true, lastRunAt: null }
    const now = 2 * day
    expect(calendarCell(span({ ok: 0, failed: 1, planned: 1, lastRunAt: 9, lastOutcome: 'failed' }), column, lane, on, now)).toEqual({ kind: 'time', at: 9, outcome: 'failed' })
    expect(calendarCell(span({ ok: 96, planned: 96 }), column, lane, on, now)).toMatchObject({ kind: 'count', runs: 96, isShort: false })
    // Fewer runs than planned: the host was off for a part of the day.
    expect(calendarCell(span({ ok: 40, planned: 96 }), column, lane, on, now)).toMatchObject({ kind: 'count', runs: 40, isShort: true })
    expect(calendarCell(span({ planned: 96 }), column, lane, on, now)).toEqual({ kind: 'missed', planned: 96 })
    // The day of the next run names its time; a day to come of a paused schedule is paused, not missed.
    expect(calendarCell(span({ planned: 1 }), { start: 3 * day, end: 4 * day }, lane, on, now)).toEqual({ kind: 'next', at: lane.upcoming[0] })
    expect(calendarCell(span({ planned: 1 }), { start: 4 * day, end: 5 * day }, { upcoming: [] }, { enabled: false, lastRunAt: null }, now)).toEqual({ kind: 'paused' })
    expect(calendarCell(span({ planned: 1 }), { start: 4 * day, end: 5 * day }, lane, on, now)).toEqual({ kind: 'empty' })
    // A paused schedule did not run after its last run: those past days are paused; a day before it is missed.
    const paused = { enabled: false, lastRunAt: 2 * day + 3 * 60 * 60_000 }
    expect(calendarCell(span({ planned: 1 }), { start: day, end: 2 * day }, { upcoming: [] }, paused, 5 * day)).toEqual({ kind: 'missed', planned: 1 })
    expect(calendarCell(span({ planned: 1 }), { start: 3 * day, end: 4 * day }, { upcoming: [] }, paused, 5 * day)).toEqual({ kind: 'paused' })
  })

  test('a lane joins its paused days into one piece that says since when, names "runs" once, and shows a next run after the week in its last cell', () => {
    const monday = new Date(2026, 10, 9).getTime()
    const edges = calendarEdges('week', monday)
    const now = edges[6] + 12 * 60 * 60_000
    const columns = calendarColumns('week', edges, now)
    const ran = span({ ok: 1, planned: 1, lastRunAt: edges[0] + 3 * 60 * 60_000, lastOutcome: 'ok' })
    const pausedLane = { name: 'prune', spans: [ran, ...Array.from({ length: 6 }, () => span({ planned: 1 }))], upcoming: [] }
    const pieces = calendarLane(pausedLane, columns, { enabled: false, lastRunAt: ran.lastRunAt }, 'week', now)
    expect(pieces.map((piece) => [piece.cell.kind, piece.columns])).toEqual([['time', 1], ['paused', 6]])
    expect(pieces[1].since).toBe(columns[1].label)

    const counts = { name: 'poll', spans: Array.from({ length: 7 }, () => span({ ok: 96, planned: 96 })), upcoming: [] }
    expect(calendarLane(counts, columns, { enabled: true, lastRunAt: now }, 'week', now).map((piece) => piece.hasUnit)).toEqual([true, false, false, false, false, false, false])

    const nextMonday = edges[7] + 9 * 60 * 60_000
    const weekly = { name: 'digest', spans: Array.from({ length: 7 }, () => span()), upcoming: [nextMonday] }
    expect(calendarLane(weekly, columns, { enabled: true, lastRunAt: null }, 'week', now).at(-1)?.cell).toEqual({ kind: 'later', at: nextMonday })
    // A paused schedule has no next run to name.
    expect(calendarLane(weekly, columns, { enabled: false, lastRunAt: null }, 'week', now).at(-1)?.cell.kind).toBe('paused')
  })

  test('a cron trigger shows its five parts, an every part quiet; an interval shows its period', () => {
    expect(triggerParts({ type: 'cron', expr: '0 9 * * 1' }).map((part) => [part.value, part.label, part.isEvery])).toEqual([
      ['0', 'minute', false], ['9', 'hour', false], ['*', 'day', true], ['*', 'month', true], ['1', 'weekday', false],
    ])
    expect(triggerParts({ type: 'interval', everyMinutes: 120 })).toEqual([{ value: '2', label: 'hours', isEvery: false }])
  })

  test('a failed last run says why and what to do, because a failed run does not try again', () => {
    const line = scheduleLastRunLine({ lastRunAt: Date.now() - 60_000, lastOutcome: 'failed', lastError: 'post-to-slack needs SLACK_WEBHOOK_URL.\n  at x' }, Date.now())
    expect(line).toContain(': post-to-slack needs SLACK_WEBHOOK_URL. A failed run does not try again')
    expect(line).toEndWith('repair the cause, then press Run now.')
    expect(scheduleLastRunLine({ lastRunAt: null, lastOutcome: null, lastError: null }, Date.now())).toBe('No run yet.')
  })
})

describe('the history and the deploy preflight', () => {
  const version = (number: number, state: 'building' | 'active' | 'superseded' | 'failed', error: string | null = null) => ({
    number, state, error, message: '', createdAt: 0, createdBy: { kind: 'system' as const }, permissionsNotice: null, operationCount: 1, hasUi: false, revision: 'c', protocol: 4, buildMs: null, activations: [],
  })
  const entry = (position: AppChangeLogEntry['position'], versions: ReturnType<typeof version>[]): AppChangeLogEntry => ({
    revision: { commit: 'c', message: 'm', savedAt: Date.now() - 60_000, versions: versions.map((built) => built.number), stats: { files: 1, additions: 1, deletions: 0 } },
    position, versions, canDeploy: versions.every((built) => built.state === 'failed'), restorable: versions.find((built) => built.state === 'superseded') ?? null,
  })

  test('a save takes the session mark of its state, never a word: idle, complete when live, working while it builds, error when its builds failed', () => {
    expect(historyState(entry('ahead', []))).toBe('idle')
    expect(historyState(entry('live', [version(14, 'active')]))).toBe('ok')
    expect(historyState(entry('behind', [version(13, 'superseded')]))).toBe('idle')
    expect(historyState(entry('ahead', [version(15, 'building')]))).toBe('running')
    expect(historyState(entry('behind', [version(12, 'failed', 'The build failed: app.ts:88')]))).toBe('failed')
  })

  test('the line under a save is quiet facts: when it was saved, or its version and time; a failed build names its place in code type', () => {
    const now = Date.now()
    expect(historyMeta(entry('behind', [version(12, 'failed', 'The build failed: src/app.ts:88:4 Unexpected token')]), now)).toEqual({ text: 'src/app.ts:88', isCode: true })
    // A build error with no place in the source is said in words, not dropped.
    expect(historyMeta(entry('behind', [version(12, 'failed', 'The build failed: out of memory')]), now)).toEqual({ text: 'out of memory', isCode: false })
    expect(historyMeta(entry('ahead', []), now).text).toStartWith('Saved ')
    expect(historyMeta(entry('behind', [version(13, 'superseded')]), now).text).toStartWith('v13 · ')
    // The live save names who made it live; no state word is in the line.
    const live = historyMeta(entry('live', [version(14, 'active')]), now).text
    expect(live).toStartWith('v14 · ')
    expect(live).not.toMatch(/live|deployed/i)
    expect(buildErrorPlace('no place here')).toBeNull()
  })

  test('this deploy names what the save may newly use and declares as plain facts; a failed build and a missing secret go to callouts', () => {
    const none = { added: [], removed: [] }
    const preflight: AppDeployPreflight = {
      commit: 'c', against: 14, buildError: null, network: { added: ['hooks.slack.com'], removed: [] }, readPaths: none, writePaths: none, models: none, integrations: none,
      operations: none, workflows: none, schedules: none, webhooks: { added: [], removed: ['pushed'] }, signals: none, secretsMissing: [{ name: 'SLACK_WEBHOOK_URL', label: 'Slack' }],
    }
    expect(preflightLines(preflight)).toEqual([
      { words: 'May reach', name: 'hooks.slack.com', isCode: false },
      { words: 'Removes the webhook', name: 'pushed', isCode: true },
    ])
    expect(missingSecretsTail(1)).toStartWith(', which is not set.')
    expect(missingSecretsTail(2)).toStartWith(', which are not set.')
    // A failed build has no facts: the error callout says why a deploy fails.
    const failed = { ...preflight, buildError: 'The build failed: x is not defined' }
    expect(preflightLines(failed)).toEqual([])
    expect(preflightBuildError(failed)).toBe('The build fails: x is not defined')
    expect(preflightBuildError(preflight)).toBeNull()
  })
})
