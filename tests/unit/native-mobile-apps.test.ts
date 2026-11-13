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
} from '../../apps/mobile/src/features/apps/apps'
import { appDocument, appMessageScript, readAppCall, relayAppCall } from '../../apps/mobile/src/features/apps/app-frame'

// The phone's app screens (docs/plans/apps.md §9). These pin what the owner
// reads and what the app frame does: a list row names what needs the owner, a
// schedule and a caller read as words, a call of the UI always gets an
// answer, and a rollback and a delete say what they do before they run.

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
    stopped: false,
    hasUi: true,
    operationCount: 2,
    project: null,
    createdBy: owner,
    createdAt: NOW - 1000 * MINUTE,
    updatedAt: NOW,
    lastCallAt: NOW - 5 * MINUTE,
    attention: [],
    ...overrides,
  }
}

const descriptor = {
  solusApp: 2,
  name: 'Notes',
  description: '',
  permissions: { network: [], files: { read: [], write: [] } },
  integrations: [],
  secrets: [],
  operations: [
    { name: 'list', kind: 'query', description: 'The newest notes.', input: {} },
    { name: 'add', kind: 'mutation', description: '', input: {} },
  ],
  schedules: [],
  webhooks: [],
} satisfies AppDescriptor

function appState(app: AppSummary, withDescriptor = true): AppState {
  return { app, descriptor: withDescriptor ? descriptor : null, roles: [], secrets: [], network: [], permissionsNotice: null }
}

describe('the Apps list', () => {
  test('a row names the app, the version that runs, the last call, and each thing that needs the owner', () => {
    // WHY: the list is where the owner sees that an app needs them. A stopped
    // app is the owner's own choice, so only the other items read as faults.
    const item = appListItem(summary({
      stopped: true,
      attention: [
        { kind: 'secret-missing', detail: 'The secret Database URL is not set.' },
        { kind: 'stopped', detail: 'The app is stopped.' },
      ],
    }), NOW)
    expect(item).toEqual({
      title: 'Notes',
      trailing: 'v3',
      lines: [
        { text: 'Last call 5m ago' },
        { text: 'The secret Database URL is not set.', tone: 'danger' },
        { text: 'The app is stopped.', tone: 'muted' },
      ],
    })
  })

  test('an app with no successful deploy and no call says so, and promises no version', () => {
    const item = appListItem(summary({ activeVersion: null, lastCallAt: null }), NOW)
    expect(item.trailing).toBe('No version')
    expect(item.lines[0]).toEqual({ text: 'No calls yet' })
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
    expect(appBody(appState(failed, false))).toEqual({ kind: 'no-version', error: 'Version 1 failed: migration 0001 has a syntax error.' })
    expect(appBody(appState(summary({ activeVersion: null }), false))).toEqual({ kind: 'no-version', error: null })
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
    // WHY: an app never asks the person first (decision 11): the call runs at once.
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
    ...overrides,
  })

  test('only an earlier version can be made active', () => {
    // WHY: the active version already runs, and a failed version never ran.
    expect(canMakeActive(version())).toBe(true)
    expect(canMakeActive(version({ state: 'active' }))).toBe(false)
    expect(canMakeActive(version({ state: 'failed' }))).toBe(false)
  })

  test('a version shows its message, when and by whom, and why it failed', () => {
    expect(versionLines(version(), NOW)).toEqual([{ text: 'Add tags' }, { text: '3h ago · Ada' }])
    expect(versionLines(version({ state: 'failed', message: '', error: 'Migration 0002 failed.' }), NOW)).toEqual([
      { text: 'No message' },
      { text: '3h ago · Ada' },
      { text: 'Migration 0002 failed.', tone: 'danger' },
    ])
  })

  test('the question before a rollback says that data is not rewound', () => {
    // WHY: decision 6. A person who expects a rollback of data would lose trust in what they see after it.
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
      ...overrides,
    })
    expect(callLines(call())).toEqual([{ text: 'Schedule digest · v3' }, { text: 'Completed' }])
    expect(callLines(call({ outcome: 'running', finishedAt: null }))[1]).toEqual({ text: 'Running' })
    expect(callLines(call({ outcome: 'failed', error: 'UNIQUE constraint failed: notes.id' }))[1]).toEqual({ text: 'UNIQUE constraint failed: notes.id', tone: 'danger' })
  })
})
