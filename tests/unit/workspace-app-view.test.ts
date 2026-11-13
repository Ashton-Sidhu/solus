import { describe, expect, test } from 'bun:test'
import type { AppScheduleView, AppState, AppSummary } from '@solus/contracts/apps'
import {
  APP_MISSING_TEXT,
  APP_NO_VERSION_TEXT,
  appDeleteConfirmText,
  appSurfacePhase,
  callerText,
  appMenuSections,
  appProblems,
  problemsTone,
  scheduleLastRunText,
  scheduleNextRunText,
  scheduleTriggerText,
  versionLabel,
  type AppSurfaceFacts,
} from '@solus/workspace-ui/components/app/lib/app-view'
import { opensBesideConversation } from '@solus/workspace-ui/components/app/lib/app-deploy'

function app(patch: Partial<AppSummary> = {}): AppSummary {
  return {
    id: 'app_1',
    slug: 'notes',
    name: 'Notes',
    description: '',
    organizationId: 'local',
    activeVersion: 2,
    latestVersion: 2,
    stopped: false,
    hasUi: true,
    operationCount: 2,
    project: null,
    createdBy: { kind: 'system' },
    createdAt: 0,
    updatedAt: 0,
    lastCallAt: null,
    attention: [],
    ...patch,
  }
}

function stateOf(summary: AppSummary): AppState {
  return { app: summary, descriptor: null, roles: [], secrets: [], network: ['api.example.com'], permissionsNotice: null }
}

function facts(patch: Partial<AppSurfaceFacts>): AppSurfaceFacts {
  const summary = app()
  return { hostPresent: true, hostStatus: 'ready', app: summary, state: stateOf(summary), stateError: null, ui: { version: 2, html: '<p>ui</p>' }, uiError: null, ...patch }
}

// The app surface shows one state at a time (docs/plans/apps.md §9). A wrong
// one is a lying spinner or an empty frame.
describe('what the app surface shows', () => {
  test('the frame, when the app has a UI and the host answered with it', () => {
    expect(appSurfacePhase(facts({})).kind).toBe('frame')
  })

  test('a stopped app still opens its UI: only its operations do not run', () => {
    const stopped = app({ stopped: true, attention: [{ kind: 'stopped', detail: 'The app is stopped.' }] })
    expect(appSurfacePhase(facts({ app: stopped, state: stateOf(stopped) })).kind).toBe('frame')
    // Stopped is the owner's own choice, with its own bar and a Start button: it is not a problem.
    expect(appProblems(stopped)).toEqual([])
    expect(problemsTone(appProblems(stopped))).toBeNull()
  })

  test('each problem names the section of the menu where the owner acts on it', () => {
    // WHY: the app surface says no problem over the app. The menu button has a dot and the menu opens the
    // Problems section, so each row there must lead to the place that fixes it.
    const waiting = app({ attention: [
      { kind: 'secret-missing', detail: 'PostgreSQL URL is not set.' },
      { kind: 'schedule-failed', detail: 'The schedule sync failed: timeout' },
      { kind: 'version-failed', detail: 'Version 2 did not start: no such table' },
    ] })
    expect(appProblems(waiting).map((problem) => [problem.tone, problem.section])).toEqual([
      ['warning', 'secrets'],
      ['error', 'schedules'],
      ['error', 'versions'],
    ])
  })

  test('the dot is a warning for a secret with no value, and an error when a part of the app does not work', () => {
    // WHY: an app works without a secret it does not use (a database browser with SQLite only),
    // so that must not look like a failure of the app.
    const secret = { kind: 'secret-missing', detail: 'PostgreSQL URL is not set.' } as const
    expect(problemsTone(appProblems(app({ attention: [secret] })))).toBe('warning')
    expect(problemsTone(appProblems(app({ attention: [secret, { kind: 'schedule-failed', detail: 'The schedule sync failed.' }] })))).toBe('error')
    expect(problemsTone(appProblems(app({})))).toBeNull()
  })

  test('the menu lists Problems while the app has one, and keeps it for the person who reads it', () => {
    const ids = (count: number, open: Parameters<typeof appMenuSections>[1] = null) => appMenuSections(count, open).map((section) => section.id)
    expect(ids(0)).not.toContain('problems')
    expect(ids(2)[0]).toBe('problems')
    // The last problem went away while the section was open: the section stays and says so.
    expect(ids(0, 'problems')).toContain('problems')
  })

  test('the operations, for an app with no UI', () => {
    const headless = app({ hasUi: false })
    expect(appSurfacePhase(facts({ app: headless, state: stateOf(headless), ui: undefined })).kind).toBe('operations')
    // The host can also answer that the active version has no UI file.
    expect(appSurfacePhase(facts({ ui: null })).kind).toBe('operations')
  })

  test('the error of the failed version, when no version is active', () => {
    const failed = app({ activeVersion: null, attention: [{ kind: 'version-failed', detail: 'Version 1 failed: migration 0002_tags.sql has a syntax error.' }] })
    expect(appSurfacePhase(facts({ app: failed, state: undefined, ui: undefined }))).toEqual({
      kind: 'no-version',
      detail: 'Version 1 failed: migration 0002_tags.sql has a syntax error.',
    })
    expect(appSurfacePhase(facts({ app: app({ activeVersion: null }), state: undefined, ui: undefined }))).toEqual({ kind: 'no-version', detail: APP_NO_VERSION_TEXT })
  })

  test('that the host is gone, whatever the client still holds of the app', () => {
    // WHY: rows of a host that went away are old. The surface must not draw a frame whose calls fail.
    expect(appSurfacePhase(facts({ hostPresent: false })).kind).toBe('host-gone')
  })

  test('loading only while a read can still answer', () => {
    expect(appSurfacePhase(facts({ app: undefined, state: undefined, ui: undefined, hostStatus: 'loading' })).kind).toBe('loading')
    expect(appSurfacePhase(facts({ app: undefined, state: undefined, ui: undefined, hostStatus: null })).kind).toBe('loading')
    expect(appSurfacePhase(facts({ state: undefined })).kind).toBe('loading')
    expect(appSurfacePhase(facts({ ui: undefined })).kind).toBe('loading')
  })

  test('an error with a way to retry, when a read failed or the host has no such app', () => {
    expect(appSurfacePhase(facts({ app: undefined, state: undefined, ui: undefined, hostStatus: 'ready' }))).toEqual({ kind: 'error', message: APP_MISSING_TEXT })
    expect(appSurfacePhase(facts({ state: undefined, stateError: 'The host refused.' }))).toEqual({ kind: 'error', message: 'The host refused.' })
    expect(appSurfacePhase(facts({ ui: undefined, uiError: 'No UI answer.' }))).toEqual({ kind: 'error', message: 'No UI answer.' })
  })
})

describe('a deploy opens the app', () => {
  const deploy = { serverId: 'h1', sessionId: 's1' }

  test('only beside the conversation that deployed it, while that conversation leads', () => {
    // WHY: an app that opens over a page, a draft, or another conversation takes
    // the person away from what they read. A session with the same id on another host is another session.
    expect(opensBesideConversation(deploy, { sessionId: 's1', serverId: 'h1' })).toBe(true)
    expect(opensBesideConversation(deploy, { sessionId: 's2', serverId: 'h1' })).toBe(false)
    expect(opensBesideConversation(deploy, { sessionId: 's1', serverId: 'h2' })).toBe(false)
    expect(opensBesideConversation(deploy, null)).toBe(false)
  })
})

describe('the words of the app surface', () => {
  const NOW = Date.UTC(2026, 10, 11, 12)
  const schedule = (patch: Partial<AppScheduleView>): AppScheduleView => ({
    name: 'digest',
    trigger: { type: 'interval', everyMinutes: 60 },
    run: 'sendDigest',
    enabled: true,
    nextRunAt: NOW + 30 * 60_000,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
    ...patch,
  })

  test('a header names the active version, or says there is none', () => {
    expect(versionLabel(3)).toBe('v3')
    expect(versionLabel(null)).toBe('No version')
  })

  test('a schedule says when it runs next, unless it is paused or the app is stopped', () => {
    // WHY: a next run time on a schedule that cannot fire is a lie.
    expect(scheduleNextRunText(schedule({}), false, NOW)).toBe('Next run in 30 min')
    expect(scheduleNextRunText(schedule({ enabled: false }), false, NOW)).toBe('Paused')
    expect(scheduleNextRunText(schedule({}), true, NOW)).toBe('The app is stopped')
    expect(scheduleNextRunText(schedule({ nextRunAt: null }), false, NOW)).toBe('No next run')
    expect(scheduleTriggerText(schedule({}))).toBe('Every hour')
  })

  test('a schedule says how its last run ended, and nothing before it ran', () => {
    expect(scheduleLastRunText(schedule({}), NOW)).toBeNull()
    expect(scheduleLastRunText(schedule({ lastRunAt: NOW - 5 * 60_000, lastOutcome: 'ok' }), NOW)).toBe('Last run OK 5 min ago')
    expect(scheduleLastRunText(schedule({ lastRunAt: NOW - 5 * 60_000, lastOutcome: 'failed' }), NOW)).toBe('Last run failed 5 min ago')
  })

  test('the call log names each caller in words', () => {
    const webhooks = [{ name: 'issueOpened', run: 'onIssue', webhookId: 'w1', enabled: true, urlMode: 'cloud' as const, url: null, secret: null, problem: null }]
    expect(callerText({ kind: 'ui' })).toBe('The UI')
    expect(callerText({ kind: 'agent', sessionId: 's1' })).toBe('An agent')
    expect(callerText({ kind: 'schedule', name: 'digest' })).toBe('Schedule digest')
    expect(callerText({ kind: 'webhook', webhookId: 'w1' }, webhooks)).toBe('Webhook issueOpened')
    expect(callerText({ kind: 'webhook', webhookId: 'gone' }, webhooks)).toBe('A webhook')
  })

  test('the delete confirmation names everything that goes with the app', () => {
    const text = appDeleteConfirmText('Notes')
    for (const lost of ['Notes', 'data', 'repository', 'schedules', 'secrets', 'webhooks']) expect(text).toContain(lost)
  })
})
