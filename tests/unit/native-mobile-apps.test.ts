import { describe, expect, test } from 'bun:test'
import type { AppCallView, AppDescriptor, AppScheduleView, AppState, AppSummary, AppVersionView, AppWebhookView } from '@solus/contracts/apps'
import {
  appBody,
  appListItem,
  appNames,
  callerText,
  callLines,
  canMakeActive,
  deleteConfirmation,
  makeActiveConfirmation,
  scheduleLines,
  sortApps,
  triggerText,
  versionLines,
  webhookLines,
  appProblemCount,
  manageAppLabel,
  parseOperationInput,
  runtimeText,
} from '../../apps/mobile/src/features/apps/apps'
import { appDocument, appMessageScript, readAppCall, relayAppCall } from '../../apps/mobile/src/features/apps/app-frame'

// The phone's app screens (docs/plans/apps.md §9). These pin what the owner
// reads and what the app frame does: a list row says the app's state and how
// many problems need the owner, a schedule and a caller read as words, a call
// of the UI always gets an answer, a file the UI gives the person stays on
// this client, and a rollback and a delete say what they do before they run.

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)
const MINUTE = 60_000
const owner = { kind: 'user', user: { id: 'u1', displayName: 'Ada' } } as AppSummary['createdBy']

function summary(overrides: Partial<AppSummary> = {}): AppSummary {
  return {
    id: 'app-1',
    slug: 'notes',
    name: 'Notes',
    description: '',
    organizationId: 'local',
    activeVersion: 3,
    latestVersion: 3,
    latestRevision: 'a'.repeat(40),
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
  name: 'Notes',
  description: '',
  instructions: '',
  permissions: { network: [], files: { read: [], write: [] } },
  integrations: [],
  secrets: [],
  operations: [
    { name: 'list', kind: 'query', description: 'The newest notes.', input: {} },
    { name: 'add', kind: 'mutation', description: '', input: {} },
  ],
  schedules: [],
  webhooks: [],
  workflows: [],
  signals: [],
} satisfies AppDescriptor

const idleRunner = { running: false, startedAt: null, inFlight: 0, rssBytes: null }

function appState(app: AppSummary, withDescriptor = true): AppState {
  return {
    app,
    descriptor: withDescriptor ? descriptor : null,
    roles: [],
    secrets: [],
    network: [],
    permissionsNotice: null,
    runtime: idleRunner,
    repositoryPath: '/data/apps/repositories/app-1.git',
  }
}

describe('the Apps list', () => {
  test('a host with missing counts does not show an invalid failed-call count', () => {
    for (const field of ['calls24h', 'failed24h']) {
      const app = summary({ calls24h: 12, failed24h: 2 })
      Reflect.deleteProperty(app, field)
      expect(appListItem(app, NOW).lines).toEqual([{ text: 'Running · Last call 5m ago' }])
    }
  })

  test('a row says the state, the version, the last call, the failed calls of 24 hours, and how many problems need the owner', () => {
    // WHY: the list is where the owner sees that an app needs them (plan §9.3).
    // A stopped app is the owner's own choice, so it is the state and not a problem.
    const item = appListItem(summary({
      stopped: true,
      calls24h: 120,
      failed24h: 3,
      attention: [
        { kind: 'secret-missing', detail: 'The secret Database URL is not set.' },
        { kind: 'workflow-failed', detail: 'The last run of build failed.' },
        { kind: 'stopped', detail: 'The app is stopped.' },
      ],
    }), NOW)
    expect(item).toEqual({
      title: 'Notes',
      trailing: 'v3',
      lines: [
        { text: 'Stopped · Last call 5m ago' },
        { text: '3 of 120 calls failed in 24 h', tone: 'danger' },
        { text: '2 problems', tone: 'danger' },
      ],
    })
  })

  test('a healthy app shows one quiet line', () => {
    expect(appListItem(summary({ calls24h: 40 }), NOW).lines).toEqual([{ text: 'Running · Last call 5m ago' }])
  })

  test('an app with no successful deploy and no call says so, and promises no version', () => {
    const item = appListItem(summary({ activeVersion: null, lastCallAt: null }), NOW)
    expect(item.trailing).toBeNull()
    expect(item.lines[0]).toEqual({ text: 'No version · No calls yet' })
  })

  test('apps are in name order, and an id finds its name', () => {
    const apps = sortApps([summary({ id: 'b', name: 'Notes' }), summary({ id: 'a', name: 'Digest' })])
    expect(apps.map((app) => app.name)).toEqual(['Digest', 'Notes'])
    expect(appNames(apps).get('b')).toBe('Notes')
  })
})

describe('the app screen', () => {
  test('an app with a UI shows its frame, also while it is stopped', () => {
    // WHY: plan §6: the UI of a stopped app still opens; its operations fail with a message.
    expect(appBody(appState(summary()))).toEqual({ kind: 'frame' })
    expect(appBody(appState(summary({ stopped: true })))).toEqual({ kind: 'frame' })
  })

  test('an app with no UI shows the operations its active version declares', () => {
    expect(appBody(appState(summary({ hasUi: false })))).toEqual({ kind: 'operations', operations: descriptor.operations })
  })

  test('an app with no active version shows why its deploy failed, never a frame', () => {
    const failed = summary({ activeVersion: null, attention: [{ kind: 'version-failed', detail: 'Version 1 failed: migration 0001 has a syntax error.' }] })
    expect(appBody(appState(failed, false))).toEqual({ kind: 'no-version', error: 'Version 1 failed: migration 0001 has a syntax error.', waitsForDeploy: false })
    expect(appBody(appState(summary({ activeVersion: null }), false))).toEqual({ kind: 'no-version', error: null, waitsForDeploy: false })
  })

  test('an app that was saved and never deployed says that a save waits', () => {
    // WHY: a save and a deploy are two acts (decision 6), so an app can have revisions and no version.
    expect(appBody(appState(summary({ activeVersion: null, latestVersion: null, hasUndeployedRevision: true }), false)))
      .toEqual({ kind: 'no-version', error: null, waitsForDeploy: true })
  })

  test('the runner reads as one line: off, or since when, what is in progress, and its memory', () => {
    expect(runtimeText(idleRunner, NOW)).toBe('Off. It starts for the next call.')
    expect(runtimeText({ running: true, startedAt: NOW - 3 * MINUTE, inFlight: 2, rssBytes: 88 * 1024 * 1024 }, NOW)).toBe('Started 3m ago · 2 in progress · 88 MiB of memory')
    expect(runtimeText({ running: true, startedAt: NOW - 3 * MINUTE, inFlight: 0, rssBytes: null }, NOW)).toBe('Started 3m ago · idle')
  })
})

describe('the problems of an app', () => {
  test('the menu button counts what the owner must act on, and stopped is not one', () => {
    // WHY: the app screen says no problem over the app. The badge on its menu button is the
    // only sign there, and Android shows the button by its label.
    const app = summary({ stopped: true, attention: [
      { kind: 'stopped', detail: 'This app is stopped.' },
      { kind: 'secret-missing', detail: 'PostgreSQL URL is not set.' },
      { kind: 'schedule-failed', detail: 'The schedule sync failed: timeout' },
    ] })
    expect(appProblemCount(app)).toBe(2)
    expect(manageAppLabel(2)).toBe('Manage app, 2 problems')
    expect(manageAppLabel(1)).toBe('Manage app, 1 problem')
    expect(manageAppLabel(appProblemCount(summary({})))).toBe('Manage app')
  })
})

describe('the app frame', () => {
  const PAGE = '<html><body><div id="root"></div></body></html>'

  test('the document is an app frame: the app policy with the declared hosts, the bridge, and the phone viewport', () => {
    const document = appDocument(PAGE, ':root{}', ['api.example.com'])
    expect(document.startsWith('<!doctype html>')).toBe(true)
    expect(document).toContain('connect-src https://api.example.com wss://api.example.com')
    expect(document).toContain('window.solusApp')
    expect(document).toContain('width=device-width')
    // An app that declares no host reaches none.
    expect(appDocument(PAGE, ':root{}', [])).toContain("connect-src 'none'")
  })

  test('only a call of the UI is a call', () => {
    expect(readAppCall(JSON.stringify({ type: 'solus-app-call', id: 4, name: '@app/list', args: { limit: 5 } }))).toEqual({ type: 'solus-app-call', id: 4, name: '@app/list', args: { limit: 5 } })
    expect(readAppCall(JSON.stringify({ type: 'solus-artifact-height', h: 300 }))).toBeNull()
    expect(readAppCall('not json')).toBeNull()
  })

  test('a call goes to the host with its arguments as JSON, and the UI gets the value under the id of the call', async () => {
    // WHY: an app never asks the person first (decision 13): the call runs at once.
    const seen: [string, string][] = []
    const script = await relayAppCall(JSON.stringify({ type: 'solus-app-call', id: 7, name: '@app/add', args: { text: 'milk' } }), async (name, argumentsJson) => {
      seen.push([name, argumentsJson])
      return JSON.stringify({ value: { id: 'n1', text: 'milk' } })
    })
    expect(seen).toEqual([['@app/add', '{"text":"milk"}']])
    expect(script).toBe(appMessageScript({ type: 'solus-app-result', id: 7, ok: true, value: { id: 'n1', text: 'milk' } }))
  })

  test('a refused call still answers the UI, with the reason the host gave', async () => {
    // WHY: a UI that gets no answer waits forever. A stopped app must say that it is stopped.
    const script = await relayAppCall(JSON.stringify({ type: 'solus-app-call', id: 8, name: '@app/add', args: {} }), () => Promise.reject(new Error('This app is stopped.')))
    expect(script).toBe(appMessageScript({ type: 'solus-app-result', id: 8, ok: false, error: 'This app is stopped.' }))
  })

  test('a file the UI gives the person is answered on this client and never reaches the host', async () => {
    // WHY: `@client/save` is the client's own to answer (plan §5): on a phone it opens the share sheet.
    const saved: { name: string; type: string; data: string }[] = []
    let hostCalls = 0
    const script = await relayAppCall(
      JSON.stringify({ type: 'solus-app-call', id: 9, name: '@client/save', args: { name: 'report.csv', type: 'text/csv', data: 'YSxi' } }),
      async () => {
        hostCalls += 1
        return '{}'
      },
      { save: async (file) => { saved.push(file) } },
    )
    expect(saved).toEqual([{ name: 'report.csv', type: 'text/csv', data: 'YSxi' }])
    expect(hostCalls).toBe(0)
    expect(script).toBe(appMessageScript({ type: 'solus-app-result', id: 9, ok: true, value: null }))
  })

  test('a share sheet that fails still answers the UI with the reason', async () => {
    const script = await relayAppCall(
      JSON.stringify({ type: 'solus-app-call', id: 10, name: '@client/save', args: { name: 'report.csv', data: 'YSxi' } }),
      async () => '{}',
      { save: () => Promise.reject(new Error('Saving and sharing files is unavailable on this device.')) },
    )
    expect(script).toBe(appMessageScript({ type: 'solus-app-result', id: 10, ok: false, error: 'Saving and sharing files is unavailable on this device.' }))
  })

  test('a message that is not a call starts nothing on the host', async () => {
    let called = false
    const script = await relayAppCall(JSON.stringify({ type: 'solus-artifact-height', h: 10 }), async () => {
      called = true
      return '{}'
    })
    expect(script).toBeNull()
    expect(called).toBe(false)
  })

  test('an answer and an event reach the UI as a message on its own window', () => {
    expect(appMessageScript({ type: 'solus-app-event', event: 'data-changed' })).toBe('window.postMessage({"type":"solus-app-event","event":"data-changed"},"*");true;')
  })
})

describe('schedules', () => {
  test('a trigger reads as words; a cron time carries its time zone', () => {
    expect(triggerText({ type: 'interval', everyMinutes: 1 })).toBe('Every minute')
    expect(triggerText({ type: 'interval', everyMinutes: 15 })).toBe('Every 15 minutes')
    expect(triggerText({ type: 'interval', everyMinutes: 60 })).toBe('Every hour')
    expect(triggerText({ type: 'interval', everyMinutes: 180 })).toBe('Every 3 hours')
    expect(triggerText({ type: 'interval', everyMinutes: 1440 })).toBe('Every day')
    expect(triggerText({ type: 'cron', expr: '0 9 * * 1-5', timezone: 'America/Toronto' })).toBe('Weekdays at 09:00 (America/Toronto)')
    expect(triggerText({ type: 'cron', expr: '30 7 * * *' })).toBe('Every day at 07:30')
    expect(triggerText({ type: 'cron', expr: '0 18 * * 5' })).toBe('Fridays at 18:00')
    expect(triggerText({ type: 'cron', expr: '0 18 * * 7' })).toBe('Sundays at 18:00')
  })

  test('an expression the phone cannot say in words shows as written, never as wrong words', () => {
    expect(triggerText({ type: 'cron', expr: '*/5 * * * *' })).toBe('Cron */5 * * * *')
    expect(triggerText({ type: 'cron', expr: '0 9 1 * *' })).toBe('Cron 0 9 1 * *')
  })

  const schedule = (overrides: Partial<AppScheduleView> = {}): AppScheduleView => ({
    name: 'digest',
    trigger: { type: 'interval', everyMinutes: 60 },
    run: 'sendDigest',
    enabled: true,
    nextRunAt: NOW + 20 * MINUTE,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
    ...overrides,
  })

  test('a schedule says when it runs, what it runs, its next run, and its last outcome', () => {
    expect(scheduleLines(schedule(), NOW)).toEqual([
      { text: 'Every hour · runs sendDigest' },
      { text: 'Next run in 20m' },
      { text: 'No run yet' },
    ])
  })

  test('a paused schedule promises no next run, and a failed run shows its error', () => {
    // WHY: a failed run does not retry (plan §8), so the owner must see why it failed.
    const lines = scheduleLines(schedule({ enabled: false, lastRunAt: NOW - 2 * 60 * MINUTE, lastOutcome: 'failed', lastError: 'The secret database is not set.' }), NOW)
    expect(lines).toEqual([
      { text: 'Every hour · runs sendDigest' },
      { text: 'Paused' },
      { text: 'Last run failed 2h ago', tone: 'danger' },
      { text: 'The secret database is not set.', tone: 'danger' },
    ])
  })
})

describe('versions', () => {
  const version = (overrides: Partial<AppVersionView> = {}): AppVersionView => ({
    number: 2,
    state: 'superseded',
    error: null,
    message: 'Add tags',
    createdAt: NOW - 3 * 60 * MINUTE,
    createdBy: owner,
    permissionsNotice: null,
    operationCount: 2,
    hasUi: true,
    revision: 'abc1234def'.padEnd(40, '0'),
    protocol: 3,
    buildMs: 4200,
    ...overrides,
  })

  test('only an earlier version can be made active', () => {
    // WHY: the active version already runs, a failed version never ran, and a version that builds is not one yet.
    expect(canMakeActive(version())).toBe(true)
    expect(canMakeActive(version({ state: 'active' }))).toBe(false)
    expect(canMakeActive(version({ state: 'failed' }))).toBe(false)
    expect(canMakeActive(version({ state: 'building' }))).toBe(false)
  })

  test('a version shows its message, when, by whom, from which revision, and how long the build took', () => {
    expect(versionLines(version(), NOW)).toEqual([{ text: 'Add tags' }, { text: '3h ago · Ada · revision abc1234 · built in 4.2 s' }])
  })

  test('a failed version shows why, a version that builds says so, and each says what it may use', () => {
    expect(versionLines(version({ state: 'failed', message: '', error: 'Migration 0002 failed.', buildMs: null }), NOW)).toEqual([
      { text: 'No message' },
      { text: '3h ago · Ada · revision abc1234' },
      { text: 'Migration 0002 failed.', tone: 'danger' },
    ])
    expect(versionLines(version({ state: 'building', buildMs: null }), NOW)[2]).toEqual({ text: 'The host builds this version now.' })
    expect(versionLines(version({ permissionsNotice: 'This app reaches api.example.com.' }), NOW).at(-1)).toEqual({ text: 'This app reaches api.example.com.' })
  })

  test('the question before a rollback says that data is not rewound', () => {
    // WHY: decision 8. A person who expects a rollback of data would lose trust in what they see after it.
    const confirmation = makeActiveConfirmation(2)
    expect(confirmation.title).toBe('Make v2 active?')
    expect(confirmation.message).toContain('data is not rewound')
  })

  test('the question before a delete names everything that goes with the app', () => {
    const confirmation = deleteConfirmation('Notes')
    expect(confirmation.title).toBe('Delete Notes?')
    for (const part of ['data', 'repository', 'schedules', 'secrets', 'webhooks']) expect(confirmation.message).toContain(part)
  })
})

describe('webhooks and calls', () => {
  const webhook = (overrides: Partial<AppWebhookView> = {}): AppWebhookView => ({
    name: 'issueOpened',
    run: 'onIssue',
    webhookId: 'wh-1',
    enabled: true,
    urlMode: 'cloud',
    url: 'https://hooks.example.com/wh-1',
    secret: 'whsec_1',
    problem: null,
    ...overrides,
  })

  test('a webhook names its mutation, and says why it cannot receive', () => {
    expect(webhookLines(webhook())).toEqual([{ text: 'Runs onIssue' }])
    expect(webhookLines(webhook({ webhookId: null, url: null, secret: null, problem: 'The webhook could not be made.' }))).toEqual([
      { text: 'Runs onIssue' },
      { text: 'The webhook could not be made.', tone: 'danger' },
    ])
    expect(webhookLines(webhook({ url: null, urlMode: 'none' }))[1]?.tone).toBe('danger')
  })

  test('each caller reads as words; a webhook is named when the app declares it', () => {
    expect(callerText({ kind: 'ui' })).toBe('The app UI')
    expect(callerText({ kind: 'agent', sessionId: 's1' })).toBe('An agent')
    expect(callerText({ kind: 'schedule', name: 'digest' })).toBe('Schedule digest')
    expect(callerText({ kind: 'webhook', webhookId: 'wh-1' }, [webhook()])).toBe('Webhook issueOpened')
    // A webhook made by hand, or one whose list is not read yet, has no name here.
    expect(callerText({ kind: 'webhook', webhookId: 'wh-9' }, [webhook()])).toBe('A webhook')
  })

  test('a workflow caller is a run of the workflow, or one step of it', () => {
    // WHY: one row of the call log is one execution of the workflow's function (no step),
    // or the call a step made with runQuery or runMutation (a step name).
    expect(callerText({ kind: 'workflow', runId: 'r1', workflow: 'build', step: '' })).toBe('Run of build')
    expect(callerText({ kind: 'workflow', runId: 'r1', workflow: 'build', step: 'save' })).toBe('Step save of build')
  })

  test('a call in the log names its caller and version, and a failed call shows its error', () => {
    const call = (overrides: Partial<AppCallView> = {}): AppCallView => ({
      id: 'c1',
      version: 3,
      operation: 'add',
      caller: { kind: 'schedule', name: 'digest' },
      startedAt: NOW - MINUTE,
      finishedAt: NOW,
      outcome: 'ok',
      error: null,
      durationMs: 120,
      logCount: 0,
      spanCount: 0,
      traceId: null,
      spanId: null,
      ...overrides,
    })
    expect(callLines(call())).toEqual([{ text: 'Schedule digest · v3 · 120 ms' }, { text: 'Completed' }])
    expect(callLines(call({ outcome: 'running', finishedAt: null, durationMs: null }))).toEqual([{ text: 'Schedule digest · v3' }, { text: 'Running' }])
    expect(callLines(call({ outcome: 'failed', error: 'UNIQUE constraint failed: notes.id' }))[1]).toEqual({ text: 'UNIQUE constraint failed: notes.id', tone: 'danger' })
  })
})

describe('a run of an operation from the Operations section', () => {
  test('the input is a JSON object, as a UI sends it; empty text is the empty object', () => {
    // WHY: the run goes through the same call as the UI's (`@app/<operation>`), whose arguments are an object.
    expect(parseOperationInput('  ')).toEqual({ ok: true, argumentsJson: '{}' })
    expect(parseOperationInput('{ "title": "Nightly" }')).toEqual({ ok: true, argumentsJson: '{"title":"Nightly"}' })
  })

  test('text that is not JSON, or JSON that is not an object, starts no call and says why', () => {
    expect(parseOperationInput('{ title: ')).toEqual({ ok: false, message: 'The input is not JSON.' })
    expect(parseOperationInput('[1, 2]')).toEqual({ ok: false, message: 'The input must be a JSON object.' })
    expect(parseOperationInput('"Nightly"')).toEqual({ ok: false, message: 'The input must be a JSON object.' })
  })
})
