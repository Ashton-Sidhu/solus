import { describe, expect, test } from 'bun:test'
import { uploadAppFile } from '@solus/client-core/app-files'
import { APP_FILE_CHUNK_BYTES } from '@solus/contracts/apps'
import type {
  AppCallDetail,
  AppDescriptor,
  AppRunView,
  AppSignalActionView,
  AppSignalOccurrence,
  AppState,
  AppStepView,
  AppSummary,
} from '@solus/contracts/apps'
import {
  callsRequest,
  canShowOlderCalls,
  hasCallFilters,
  hourBars,
  logLine,
  NO_CALL_FILTERS,
  searchOf,
  olderCallsLimit,
  operationChoices,
  operationMetricLines,
  spanRows,
} from '../../apps/mobile/src/features/apps/app-activity'
import { eventChangesRead, type AppEvent } from '../../apps/mobile/src/features/apps/app-events'
import { deviceFileSource, fileLines, uploadProgressText } from '../../apps/mobile/src/features/apps/app-file-source'
import { canRunAgain, canTerminate, runCallsRequest, runLines, runsRequest, stepLines } from '../../apps/mobile/src/features/apps/app-runs'
import { modelCallState, occurrenceState, runState, sessionState, stepState } from '../../apps/mobile/src/features/apps/app-states'
import { appProblems, appRoutesOnTop, appSectionRows, APP_SECTIONS } from '../../apps/mobile/src/features/apps/app-sections'
import {
  deliveryLine,
  enabledSaveRequest,
  newNotifyDraft,
  notifyDraftOf,
  notifySaveRequest,
  occurrenceLines,
  signalActionLines,
} from '../../apps/mobile/src/features/apps/app-signals'

// The Manage screens of an app on the phone (docs/plans/apps.md §9.2). These
// pin what the owner reads and what each screen asks its host for: a section
// row says the one fact that matters, a problem leads to the section where
// the owner acts, a filter narrows the read and never the rows on screen, the
// saves and the builds are one timeline, an event reloads only what it
// changes, and a file goes to the host in parts read from disk.

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const MINUTE = 60_000
const owner = { kind: 'user', user: { id: 'u1', displayName: 'Ada' } } as AppSummary['createdBy']

function summary(overrides: Partial<AppSummary> = {}): AppSummary {
  return {
    id: 'app-1',
    slug: 'reports',
    name: 'Reports',
    description: '',
    organizationId: 'local',
    activeVersion: 3,
    latestVersion: 3,
    latestRevision: 'c'.repeat(40),
    hasUndeployedRevision: false,
    buildingVersion: null,
    stopped: false,
    agentAccess: true,
    hasUi: true,
    operationCount: 2,
    project: null,
    createdBy: owner,
    createdAt: NOW - 1000 * MINUTE,
    updatedAt: NOW,
    lastCallAt: NOW - 5 * MINUTE,
    calls24h: 0,
    failed24h: 0,
    attention: [],
    ...overrides,
  }
}

const descriptor = {
  solusApp: 3,
  name: 'Reports',
  description: '',
  instructions: '',
  permissions: { network: [], files: { read: [], write: [] } },
  integrations: [],
  secrets: [],
  config: [],
  operations: [
    { name: 'list', kind: 'query', description: '', input: {} },
    { name: 'request', kind: 'mutation', description: '', input: {} },
  ],
  schedules: [{ name: 'nightly', trigger: { type: 'cron', expr: '0 2 * * *' }, run: 'request', input: {} }],
  webhooks: [],
  workflows: [{ name: 'build', description: '', input: {} }],
  signals: [{ name: 'report.ready', description: 'A report is ready.', payload: {} }],
} satisfies AppDescriptor

function appState(overrides: Partial<AppState> = {}): AppState {
  return {
    app: summary(),
    descriptor,
    roles: [],
    secrets: [],
    config: [],
    network: [],
    permissionsNotice: null,
    runtime: { running: false, startedAt: null, inFlight: 0, rssBytes: null },
    repositoryPath: '/data/apps/repositories/app-1.git',
    ...overrides,
  }
}

function run(overrides: Partial<AppRunView> = {}): AppRunView {
  return {
    id: 'run-1',
    workflow: 'build',
    state: 'running',
    startedAt: NOW - 10 * MINUTE,
    updatedAt: NOW,
    finishedAt: null,
    wakeAt: null,
    error: null,
    startedBy: { kind: 'ui' },
    stepCount: 2,
    version: null,
    dismissedAt: null,
    ...overrides,
  }
}

function summaryOf(state: AppState, runs: readonly AppRunView[] | null, id: string) {
  return appSectionRows(state, runs).find((row) => row.id === id)?.summary
}

describe('the sections of the Manage screen', () => {
  test('Activity shows unavailable counts when the host omits them', () => {
    for (const missing of [['calls24h'], ['failed24h'], ['calls24h', 'failed24h']]) {
      const app = summary({ calls24h: 12, failed24h: 2 })
      for (const field of missing) Reflect.deleteProperty(app, field)
      expect(summaryOf(appState({ app }), null, 'activity')).toEqual({ text: 'Call counts unavailable' })
    }
  })

  test('the list has the fourteen sections of the plans, in their order', () => {
    expect(appSectionRows(appState(), null).map((row) => row.title)).toEqual([
      'Overview', 'Activity', 'Workflows', 'Versions', 'Deployment', 'Schedules', 'Webhooks', 'Signals', 'Secrets', 'Config', 'Files', 'Operations', 'Sessions', 'Source',
    ])
    expect(APP_SECTIONS).toHaveLength(14)
  })

  test('Activity says the failed calls of 24 hours, and reads as a fault only then', () => {
    expect(summaryOf(appState({ app: summary({ calls24h: 120, failed24h: 3 }) }), null, 'activity')).toEqual({ text: '3 of 120 calls failed in 24 h', tone: 'danger' })
    expect(summaryOf(appState({ app: summary({ calls24h: 120 }) }), null, 'activity')).toEqual({ text: '120 calls in 24 h' })
    expect(summaryOf(appState(), null, 'activity')).toEqual({ text: 'No calls in 24 h' })
  })

  test('Workflows counts the runs in progress once they are read, and a failed run comes first', () => {
    const runs = [run(), run({ id: 'run-2' }), run({ id: 'run-3', state: 'sleeping' }), run({ id: 'run-4', state: 'succeeded' })]
    expect(summaryOf(appState(), runs, 'workflows')).toEqual({ text: '2 running · 1 sleeping' })
    expect(summaryOf(appState(), [run({ state: 'succeeded' })], 'workflows')).toEqual({ text: 'No run in progress' })
    // The runs are not read yet: the row says what the app declares, never a count it does not know.
    expect(summaryOf(appState(), null, 'workflows')).toEqual({ text: '1 workflow' })
    const failed = appState({ app: summary({ attention: [{ kind: 'workflow-failed', detail: 'The last run of build failed: timeout.' }] }) })
    expect(summaryOf(failed, runs, 'workflows')).toEqual({ text: 'The last run of a workflow failed', tone: 'danger' })
    // A run that failed on an older version waits for a retry: the code that runs now did not fail.
    const stale = appState({ app: summary({ attention: [{ kind: 'workflow-stale', detail: 'The last build run failed on v2. v3 has not run it yet.', runId: 'run-1' }] }) })
    expect(summaryOf(stale, runs, 'workflows')).toEqual({ text: 'A run failed on an older version' })
  })

  test('Versions says that a save waits for a deploy, and a failed version comes first', () => {
    // WHY: a save changes nothing that runs (decision 6), so the owner must see that one waits.
    expect(summaryOf(appState({ app: summary({ hasUndeployedRevision: true }) }), null, 'versions')).toEqual({ text: '1 waits for a deploy' })
    expect(summaryOf(appState(), null, 'versions')).toEqual({ text: 'v3 is active' })
    const failed = summary({ hasUndeployedRevision: true, attention: [{ kind: 'version-failed', detail: 'Version 4 failed.' }] })
    expect(summaryOf(appState({ app: failed }), null, 'versions')).toEqual({ text: 'The newest version failed', tone: 'danger' })
  })

  test('Secrets counts what is not set, in plain text; the declared sections say how many they hold or that there is none', () => {
    // WHY: a secret with no value is a step to take, not a failure. Red would read as an error.
    const secrets = [
      { name: 'token', label: 'API token', description: '', isSet: false },
      { name: 'url', label: 'Database URL', description: '', isSet: true },
    ]
    expect(summaryOf(appState({ secrets }), null, 'secrets')).toEqual({ text: '1 not set' })
    expect(summaryOf(appState({ secrets: [secrets[1]!] }), null, 'secrets')).toEqual({ text: '1 set' })
    expect(summaryOf(appState(), null, 'schedules')).toEqual({ text: '1 schedule' })
    expect(summaryOf(appState(), null, 'webhooks')).toEqual({ text: 'This app declares no webhook' })
    expect(summaryOf(appState(), null, 'operations')).toEqual({ text: '2 operations · agent access on' })
    expect(summaryOf(appState({ app: summary({ agentAccess: false }) }), null, 'operations')).toEqual({ text: '2 operations · agent access off' })
  })

  test('an app with no active version declares nothing, and its rows say so', () => {
    const state = appState({ app: summary({ activeVersion: null, hasUndeployedRevision: true }), descriptor: null })
    expect(summaryOf(state, null, 'overview')).toEqual({ text: 'No version' })
    expect(summaryOf(state, null, 'operations')).toEqual({ text: 'No version is active' })
    expect(summaryOf(state, null, 'signals')).toEqual({ text: 'No version is active' })
  })

  test('each problem leads to the section where the owner acts, and stopped is not a problem', () => {
    const app = summary({
      stopped: true,
      attention: [
        { kind: 'version-failed', detail: 'Version 4 failed.' },
        { kind: 'secret-missing', detail: 'API token is not set.' },
        { kind: 'schedule-failed', detail: 'The schedule nightly failed.' },
        { kind: 'workflow-failed', detail: 'The last run of build failed.', runId: 'run-1' },
        { kind: 'workflow-stale', detail: 'The last sync run failed on v2. v3 has not run it yet.', runId: 'run-2' },
        { kind: 'stopped', detail: 'This app is stopped.' },
      ],
    })
    // A run that failed on an older version opens the run, where the owner runs it again or dismisses it.
    expect(appProblems(app)).toEqual([
      { detail: 'Version 4 failed.', section: 'versions', tone: 'danger', runId: null },
      { detail: 'API token is not set.', section: 'secrets', tone: 'danger', runId: null },
      { detail: 'The schedule nightly failed.', section: 'schedules', tone: 'danger', runId: null },
      { detail: 'The last run of build failed.', section: 'workflows', tone: 'danger', runId: null },
      { detail: 'The last sync run failed on v2. v3 has not run it yet.', section: 'workflows', tone: 'muted', runId: 'run-2' },
    ])
  })

  test('a delete leaves every screen of the app, down to the screen the app was opened from', () => {
    const names = (...routes: string[]) => routes.map((name) => ({ name }))
    expect(appRoutesOnTop(names('Home', 'Settings', 'Apps', 'App', 'AppManage', 'AppSection'), 5)).toBe(3)
    // Another app lower in the stack stays: only the app on top was deleted.
    expect(appRoutesOnTop(names('Home', 'App', 'AppManage', 'AppSection', 'Thread', 'ThreadArtifacts', 'App', 'AppManage', 'AppSection'), 8)).toBe(3)
    expect(appRoutesOnTop(names('Home', 'Thread'), 1)).toBe(0)
  })
})

describe('the filters of the call log and of the runs', () => {
  test('a filter that is not set is not in the read, so the host narrows by what is set only', () => {
    expect(callsRequest('app-1', NO_CALL_FILTERS, 50)).toEqual({ appId: 'app-1', limit: 50 })
    expect(callsRequest('app-1', { operation: 'request', callerKind: 'schedule', outcome: 'failed', search: 'token' }, 100))
      .toEqual({ appId: 'app-1', limit: 100, operation: 'request', callerKind: 'schedule', outcome: 'failed', search: 'token' })
    expect(hasCallFilters(NO_CALL_FILTERS)).toBe(false)
    expect(hasCallFilters({ ...NO_CALL_FILTERS, outcome: 'failed' })).toBe(true)
    expect(hasCallFilters({ ...NO_CALL_FILTERS, search: 'token' })).toBe(true)
  })

  test('a search goes to the host without the spaces around it, and spaces alone are no search', () => {
    // WHY: the host refuses an empty search, and " invoice " typed in haste must find "invoice".
    expect(searchOf('  invoice-4471 ')).toBe('invoice-4471')
    expect(searchOf('   ')).toBeNull()
  })

  test('the operation filter offers what the active version declares', () => {
    expect(operationChoices(descriptor).map((choice) => choice.value)).toEqual([null, 'list', 'request'])
    expect(operationChoices(null)).toEqual([{ value: null, label: 'Every operation' }])
  })

  test('older calls are offered only behind a full page, up to the most the host gives', () => {
    expect(canShowOlderCalls(50, 50)).toBe(true)
    expect(canShowOlderCalls(37, 50)).toBe(false)
    expect(olderCallsLimit(50)).toBe(100)
    expect(olderCallsLimit(480)).toBe(500)
    expect(canShowOlderCalls(500, 500)).toBe(false)
  })

  test('the runs are read in one state when one is chosen, and the log of a run is the calls with its id', () => {
    expect(runsRequest('app-1', null)).toEqual({ appId: 'app-1', limit: 100 })
    expect(runsRequest('app-1', 'failed')).toEqual({ appId: 'app-1', limit: 100, state: 'failed' })
    expect(runCallsRequest('app-1', 'run-1')).toEqual({ appId: 'app-1', runId: 'run-1', limit: 100 })
  })
})

describe('one call', () => {
  const call = (overrides: Partial<AppCallDetail> = {}): Pick<AppCallDetail, 'spans' | 'durationMs'> => ({
    durationMs: 1000,
    spans: [
      { kind: 'sql', name: '12 statements', startMs: 600, durationMs: 100, ok: true },
      { kind: 'fetch', name: 'GET api.example.com', startMs: 100, durationMs: 500, ok: false, detail: '503' },
    ],
    ...overrides,
  })

  test('the trace is in the order the spans started, each with its time and its place in the call', () => {
    const rows = spanRows(call())
    expect(rows.map((row) => row.title)).toEqual(['Request · GET api.example.com', 'SQL · 12 statements'])
    expect(rows[0]).toMatchObject({ trailing: '500 ms', failed: true, offset: 0.1, width: 0.5, lines: [{ text: 'Started at +100 ms · 503', tone: 'danger' }] })
    expect(rows[1]).toMatchObject({ trailing: '100 ms', failed: false, offset: 0.6, width: 0.1, lines: [{ text: 'Started at +600 ms' }] })
  })

  test('a span of no time still shows, and no bar leaves the call', () => {
    const [instant] = spanRows(call({ spans: [{ kind: 'signal', name: 'report.ready', startMs: 1000, durationMs: 0, ok: true }] }))
    expect(instant!.width).toBeGreaterThan(0)
    expect(instant!.offset + instant!.width).toBeLessThanOrEqual(1)
    // A call that still runs has no time: it is as long as its last span.
    const [running] = spanRows(call({ durationMs: null, spans: [{ kind: 'tool', name: 'linear.list_issues', startMs: 0, durationMs: 400, ok: true }] }))
    expect(running).toMatchObject({ offset: 0, width: 1 })
  })

  test('a warning or an error line of the log reads as a fault', () => {
    expect(logLine({ atMs: 12, level: 'log', text: 'fetched 3 rows' })).toEqual({ text: '+12 ms  fetched 3 rows' })
    expect(logLine({ atMs: 1500, level: 'error', text: 'timeout' })).toEqual({ text: '+1.5 s  timeout', tone: 'danger' })
  })
})

describe('the last 24 hours', () => {
  test('each bar is a fraction of the busiest hour, with its failed calls inside it', () => {
    const bars = hourBars([
      { start: 1, calls: 0, failed: 0 },
      { start: 2, calls: 10, failed: 5 },
      { start: 3, calls: 20, failed: 0 },
    ])
    expect(bars).toEqual([
      { start: 1, calls: 0, failed: 0 },
      { start: 2, calls: 0.5, failed: 0.25 },
      { start: 3, calls: 1, failed: 0 },
    ])
    // An app with no call draws empty bars, never a division by zero.
    expect(hourBars([{ start: 1, calls: 0, failed: 0 }])).toEqual([{ start: 1, calls: 0, failed: 0 }])
  })

  test('an operation shows its calls, its times, and its last call; failed calls read as a fault', () => {
    expect(operationMetricLines({ operation: 'request', calls: 40, failed: 2, p50Ms: 12, p95Ms: 2400, lastAt: NOW - 3 * MINUTE }, NOW)).toEqual([
      { text: '2 of 40 calls failed', tone: 'danger' },
      { text: 'Median 12 ms · 95th percentile 2.4 s' },
      { text: 'Last call 3m ago' },
    ])
    expect(operationMetricLines({ operation: 'list', calls: 1, failed: 0, p50Ms: null, p95Ms: null, lastAt: null }, NOW)).toEqual([{ text: '1 call' }])
  })
})

describe('what an event of the app reloads', () => {
  const activity = (...kinds: ('calls' | 'runs' | 'signals' | 'files')[]): AppEvent => ({ kind: 'activity', kinds })

  test('activity reloads only the reads that its kinds name', () => {
    // WHY: the host says `apps.activity` up to twice a second for a busy app (plan §5). A Manage
    // screen that read everything each time would load the host and the phone for nothing.
    expect(eventChangesRead(activity('calls'), 'calls')).toBe(true)
    expect(eventChangesRead(activity('calls'), 'metrics')).toBe(true)
    expect(eventChangesRead(activity('calls'), 'runs')).toBe(false)
    expect(eventChangesRead(activity('calls'), 'files')).toBe(false)
    expect(eventChangesRead(activity('runs'), 'run')).toBe(true)
    expect(eventChangesRead(activity('signals'), 'occurrences')).toBe(true)
    expect(eventChangesRead(activity('signals'), 'calls')).toBe(false)
    expect(eventChangesRead(activity('files'), 'files')).toBe(true)
    expect(eventChangesRead(activity('files', 'signals'), 'signals')).toBe(true)
  })

  test('a run of a schedule is a call, and the state of the app counts calls and runs', () => {
    expect(eventChangesRead(activity('calls'), 'schedules')).toBe(true)
    expect(eventChangesRead(activity('calls'), 'state')).toBe(true)
    expect(eventChangesRead(activity('runs'), 'state')).toBe(true)
    expect(eventChangesRead(activity('files'), 'state')).toBe(false)
  })

  test('no activity changes what only a deploy changes; a change of the app reloads every read', () => {
    for (const read of ['versions', 'revisions', 'buildLog', 'webhooks', 'sessions'] as const) {
      expect(eventChangesRead(activity('calls', 'runs', 'signals', 'files'), read)).toBe(false)
      expect(eventChangesRead({ kind: 'changed' }, read)).toBe(true)
    }
  })

  test('a change of the app data alone reloads no read of the Manage screens', () => {
    // `apps.dataChanged` is for the UI of the app: its queries run again. The call that changed the data is in `apps.activity`.
    expect(eventChangesRead({ kind: 'data-changed' }, 'calls')).toBe(false)
    expect(eventChangesRead({ kind: 'deleted' }, 'state')).toBe(false)
  })
})

describe('runs and steps', () => {
  test('a run in progress can be terminated, and only a failed run starts again', () => {
    expect(canTerminate(run({ state: 'running' }))).toBe(true)
    expect(canTerminate(run({ state: 'sleeping' }))).toBe(true)
    expect(canTerminate(run({ state: 'failed' }))).toBe(false)
    expect(canRunAgain(run({ state: 'failed' }))).toBe(true)
    expect(canRunAgain(run({ state: 'terminated' }))).toBe(false)
    expect(canRunAgain(run({ state: 'succeeded' }))).toBe(false)
  })

  test('a run says its state in words, its steps, who started it, when it starts again, and why it failed', () => {
    // WHY: the state is a mark at the start of the row, with no badge. The words are in the line, so the mark is never the only signal.
    expect(runLines(run({ state: 'sleeping', wakeAt: NOW + 20 * MINUTE, startedBy: { kind: 'schedule', name: 'nightly' } }), NOW)).toEqual([
      { text: 'Sleeping · 2 steps · Schedule nightly' },
      { text: 'Starts again in 20m' },
    ])
    expect(runLines(run({ state: 'terminated' }), NOW)[0]?.text).toStartWith('Terminated · ')
    expect(runLines(run({ state: 'failed', error: 'fetch failed after 3 attempts' }), NOW)[1]).toEqual({ text: 'fetch failed after 3 attempts', tone: 'danger' })
    // The version says whether the code that ran the run still runs; a dismissed run says so.
    expect(runLines(run({ state: 'failed', version: 2, dismissedAt: NOW }), NOW)[0]).toEqual({ text: 'Failed · 2 steps · The app UI · v2 · Dismissed' })
  })

  test('a run or a call that a person stopped has its own mark: it did not fail and it did not finish', () => {
    expect(runState('terminated')).toBe('stopped')
    expect(runState('failed')).toBe('failed')
    expect(runState('succeeded')).toBe('ok')
    expect(runState('sleeping')).toBe('sleeping')
    expect(stepState('done')).toBe('ok')
    expect(modelCallState('cancelled')).toBe('stopped')
    expect(modelCallState('queued')).toBe('idle')
    expect(sessionState('interrupted')).toBe('stopped')
    expect(sessionState(null)).toBe('idle')
  })

  test('a step says its kind, its attempts, and its time; a failed step says why', () => {
    const step = (overrides: Partial<AppStepView> = {}): AppStepView => ({
      name: 'fetch',
      kind: 'do',
      state: 'done',
      attempts: 3,
      startedAt: NOW - 5 * MINUTE,
      finishedAt: NOW - 5 * MINUTE + 2400,
      wakeAt: null,
      error: null,
      result: '42',
      resultTruncated: false,
      tries: [],
      retryPolicy: null,
      ...overrides,
    })
    expect(stepLines(step(), NOW)).toEqual([{ text: 'Step · 3 attempts · took 2.4 s' }])
    expect(stepLines(step({ kind: 'sleep', state: 'sleeping', attempts: 1, finishedAt: null, wakeAt: NOW + 2 * 60 * MINUTE }), NOW)).toEqual([
      { text: 'Sleep · 1 attempt · started 5m ago' },
      { text: 'Wakes in 2h' },
    ])
    expect(stepLines(step({ state: 'failed', error: 'NonRetryableError: bad input' }), NOW).at(-1)).toEqual({ text: 'NonRetryableError: bad input', tone: 'danger' })
    // A failed step with no reason still says in words that it failed: the row has no state badge.
    expect(stepLines(step({ state: 'failed' }), NOW).at(-1)).toEqual({ text: 'Failed', tone: 'danger' })
  })
})

describe('signal actions and occurrences', () => {
  const notify: AppSignalActionView = { id: 'act-1', signal: 'report.ready', enabled: true, action: { type: 'notify', title: '{{payload.title}} is ready', detail: '' } }
  const toSession: AppSignalActionView = { id: 'act-2', signal: 'report.ready', enabled: true, action: { type: 'send_to_session', template: '', sessionId: 's1' } }

  test('the phone changes a notification; an action that names a session or an automation is not changed here', () => {
    // WHY: the phone has no picker for a session or an automation, so it must not offer a form that cannot name one.
    expect(notifyDraftOf(notify)).toEqual({ signal: 'report.ready', actionId: 'act-1', enabled: true, title: '{{payload.title}} is ready', detail: '' })
    expect(notifyDraftOf(toSession)).toBeNull()
  })

  test('a new notification is saved with no id; a changed one keeps its id and whether it is on', () => {
    expect(notifySaveRequest('app-1', { ...newNotifyDraft('report.ready'), title: ' Report ready ', detail: '' })).toEqual({
      appId: 'app-1',
      signal: 'report.ready',
      enabled: true,
      action: { type: 'notify', title: 'Report ready', detail: '' },
    })
    expect(notifySaveRequest('app-1', { ...notifyDraftOf({ ...notify, enabled: false })!, detail: 'Open it.' })).toEqual({
      appId: 'app-1',
      actionId: 'act-1',
      signal: 'report.ready',
      enabled: false,
      action: { type: 'notify', title: '{{payload.title}} is ready', detail: 'Open it.' },
    })
  })

  test('turning an action off sends the action back as it is, for each type', () => {
    // WHY: the phone turns off an action it cannot change. The save must not lose its session or its template.
    expect(enabledSaveRequest('app-1', toSession, false)).toEqual({ appId: 'app-1', actionId: 'act-2', signal: 'report.ready', enabled: false, action: toSession.action })
  })

  test('an action shows its templates, and an empty template says what it gives', () => {
    expect(signalActionLines(notify.action)).toEqual([{ text: 'Title: {{payload.title}} is ready' }])
    expect(signalActionLines(toSession.action)).toEqual([{ text: 'Gives the signal and its payload' }])
    expect(signalActionLines({ type: 'run_automation', template: 'Check {{payload.id}}\nThen tell me.', automationId: 'a1' })).toEqual([{ text: 'Template: Check {{payload.id}}' }])
  })

  test('an occurrence shows the start of its payload and how each action ended', () => {
    const occurrence: AppSignalOccurrence = {
      id: 'occ-1',
      name: 'report.ready',
      payload: '{\n  "id": "r1",\n  "title": "Nightly"\n}',
      emittedAt: NOW,
      callId: 'c1',
      runId: null,
      deliveries: [
        { actionId: 'act-1', type: 'notify', status: 'delivered', detail: null },
        { actionId: 'act-2', type: 'send_to_session', status: 'failed', detail: 'The session is archived.' },
        { actionId: 'act-3', type: 'run_automation', status: 'throttled', detail: null },
      ],
    }
    expect(occurrenceLines(occurrence)).toEqual([
      { text: '{ "id": "r1", "title": "Nightly" }' },
      { text: 'Notification: delivered' },
      { text: 'Prompt to a session failed: The session is archived.', tone: 'danger' },
      { text: 'Run of an automation did not run: it reached its limit of agent starts for the hour', tone: 'danger' },
    ])
    expect(occurrenceLines({ ...occurrence, deliveries: [] }).at(-1)).toEqual({ text: 'No action was on' })
    // The mark of the row is the worst end. A throttled action did not run, but nothing is broken: a warning, not a failure.
    expect(occurrenceState(occurrence.deliveries)).toBe('failed')
    expect(occurrenceState(occurrence.deliveries.filter((delivery) => delivery.status !== 'failed'))).toBe('warning')
    expect(occurrenceState(occurrence.deliveries.slice(0, 1))).toBe('ok')
    expect(occurrenceState([])).toBe('idle')
    expect(deliveryLine({ actionId: 'act-1', type: 'notify', status: 'delivered', detail: null }).tone).toBeUndefined()
  })
})

describe('app files on the phone', () => {
  /** A file of `size` bytes whose byte at each place is the place, so a wrong offset shows. */
  function fakeDisk(size: number) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251)
    const reads: [number, number][] = []
    const readRange = async (_uri: string, offset: number, length: number) => {
      reads.push([offset, length])
      return Buffer.from(bytes.subarray(offset, offset + length)).toString('base64')
    }
    return { bytes, reads, readRange }
  }

  test('an upload reads the file from disk one part at a time, and the host gets every byte once, in order', async () => {
    // WHY: the phone has no Blob of a chosen file. A part that is read at a wrong offset, or a file
    // read whole into one string, would corrupt the upload or exhaust the memory of the phone.
    const size = 2 * APP_FILE_CHUNK_BYTES + 1000
    const disk = fakeDisk(size)
    const received: Buffer[] = []
    const progress: number[] = []
    const host = async (name: string, argumentsJson: string) => {
      const input = JSON.parse(argumentsJson) as { index?: number; data?: string }
      if (name === '@files/begin') return JSON.stringify({ value: { uploadId: 'up-1' } })
      if (name === '@files/chunk') {
        received[input.index!] = Buffer.from(input.data!, 'base64')
        return JSON.stringify({ value: null })
      }
      return JSON.stringify({ value: { id: 'f1', name: 'rows.csv', type: 'text/csv', size, createdAt: NOW, createdBy: 'ui' } })
    }

    const source = deviceFileSource({ uri: 'file:///cache/rows.csv', name: 'rows.csv', type: 'text/csv', size }, disk.readRange)
    const file = await uploadAppFile(host, source, (sent) => progress.push(sent))

    expect(file.id).toBe('f1')
    expect(disk.reads).toEqual([[0, APP_FILE_CHUNK_BYTES], [APP_FILE_CHUNK_BYTES, APP_FILE_CHUNK_BYTES], [2 * APP_FILE_CHUNK_BYTES, 1000]])
    expect(Buffer.concat(received).equals(Buffer.from(disk.bytes))).toBe(true)
    expect(progress).toEqual([APP_FILE_CHUNK_BYTES, 2 * APP_FILE_CHUNK_BYTES, size])
  })

  test('a file over the limit is refused before a byte is read', async () => {
    const disk = fakeDisk(0)
    const source = deviceFileSource({ uri: 'file:///cache/big.bin', name: 'big.bin', type: '', size: 64 * 1024 * 1024 + 1 }, disk.readRange)
    await expect(uploadAppFile(async () => '{}', source)).rejects.toThrow('An app file is at most 64 MiB.')
    expect(disk.reads).toEqual([])
  })

  test('the progress says how far the upload is, and a file says its type, its age, and who made it', () => {
    expect(uploadProgressText({ name: 'rows.csv', sentBytes: 384 * 1024, size: 1024 * 1024 })).toBe('Uploading rows.csv: 37% of 1.0 MiB')
    expect(uploadProgressText({ name: 'empty.txt', sentBytes: 0, size: 0 })).toBe('Uploading empty.txt: 100% of 0 B')
    expect(fileLines({ id: 'f1', name: 'rows.csv', type: 'text/csv', size: 10, createdAt: NOW - 2 * 60 * MINUTE, createdBy: 'workflow' }, NOW))
      .toEqual([{ text: 'text/csv' }, { text: '2h ago · written by a workflow' }])
  })
})
