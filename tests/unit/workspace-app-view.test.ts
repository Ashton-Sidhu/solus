import { describe, expect, test } from 'bun:test'
import type { AppScheduleView, AppState, AppSummary } from '@solus/contracts/apps'
import {
  APP_MISSING_TEXT,
  APP_NO_VERSION_TEXT,
  appDeleteConfirmText,
  appSurfacePhase,
  callerText,
  appProblems,
  appSurfaceView,
  problemsTone,
  showsAppViews,
  scheduleLastRunText,
  scheduleNextRunText,
  scheduleTriggerText,
  versionLabel,
  type AppSurfaceFacts,
} from '@solus/workspace-ui/components/app/lib/app-view'
import { adjacentManageSection, manageSectionOf, manageSections } from '@solus/workspace-ui/components/app/lib/app-manage'
import { opensBesideConversation } from '@solus/workspace-ui/components/app/lib/app-deploy'
import { APP_MANAGE_SECTIONS } from '@solus/workspace-ui/contexts/workspace/routing/route-registry'

function app(patch: Partial<AppSummary> = {}): AppSummary {
  return {
    id: 'app_1',
    slug: 'notes',
    name: 'Notes',
    description: '',
    organizationId: 'local',
    activeVersion: 2,
    latestVersion: 2,
    latestRevision: 'a'.repeat(40),
    hasUndeployedRevision: false,
    buildingVersion: null,
    stopped: false,
    agentAccess: true,
    hasUi: true,
    operationCount: 2,
    project: null,
    createdBy: { kind: 'system' },
    createdAt: 0,
    updatedAt: 0,
    lastCallAt: null,
    calls24h: 0,
    failed24h: 0,
    attention: [],
    ...patch,
  }
}

function stateOf(summary: AppSummary): AppState {
  return {
    app: summary,
    descriptor: null,
    roles: [],
    secrets: [],
    network: ['api.example.com'],
    permissionsNotice: null,
    runtime: { running: false, startedAt: null, inFlight: 0, rssBytes: null },
    repositoryPath: '/data/apps/repositories/app_1.git',
  }
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

  test('each problem names the section of the Manage page where the owner acts on it', () => {
    // WHY: the app surface says no problem over the app. The Manage switch has a dot and the Overview
    // lists the problems, so each row there must lead to the place that fixes it.
    const waiting = app({ attention: [
      { kind: 'secret-missing', detail: 'PostgreSQL URL is not set.' },
      { kind: 'schedule-failed', detail: 'The schedule sync failed: timeout' },
      { kind: 'version-failed', detail: 'Version 2 did not start: no such table' },
      { kind: 'workflow-failed', detail: 'The run of build failed: step fetch' },
    ] })
    expect(appProblems(waiting).map((problem) => [problem.tone, problem.section])).toEqual([
      ['warning', 'secrets'],
      ['error', 'schedules'],
      ['error', 'versions'],
      ['error', 'workflows'],
    ])
  })

  test('the dot is amber when the only problems are secrets with no value, and red when a part of the app does not work', () => {
    // WHY: an app works without a secret it does not use (a database browser with SQLite only),
    // so that must not look like a failure of the app.
    const secret = { kind: 'secret-missing', detail: 'PostgreSQL URL is not set.' } as const
    expect(problemsTone(appProblems(app({ attention: [secret] })))).toBe('warning')
    expect(problemsTone(appProblems(app({ attention: [secret, { kind: 'schedule-failed', detail: 'The schedule sync failed.' }] })))).toBe('error')
    expect(problemsTone(appProblems(app({ attention: [secret, { kind: 'workflow-failed', detail: 'A run failed.' }] })))).toBe('error')
    expect(problemsTone(appProblems(app({})))).toBeNull()
  })

  test('an app with no UI has no frame: its Manage page is what the owner sees', () => {
    const headless = app({ hasUi: false })
    // The state is not needed to say that: the surface does not wait for it.
    expect(appSurfacePhase(facts({ app: headless, state: undefined, ui: undefined })).kind).toBe('no-ui')
    // The host can also answer that the active version has no UI file.
    expect(appSurfacePhase(facts({ ui: null })).kind).toBe('no-ui')
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

// The app surface has two views (docs/plans/apps.md §9.1): the app, and its Manage page.
describe('the view the app surface opens on', () => {
  test('an app with a UI opens on the app, and a route that names Manage opens the Manage page', () => {
    expect(appSurfaceView(undefined, app())).toBe('app')
    expect(appSurfaceView('manage', app())).toBe('manage')
  })

  test('an app with no UI opens on its Manage page', () => {
    // WHY: an app with only a backend has nothing to draw in a frame. The page where
    // its owner sees what it does is the only useful view.
    expect(appSurfaceView(undefined, app({ hasUi: false }))).toBe('manage')
  })

  test('before the app is known the surface does not jump to Manage', () => {
    expect(appSurfaceView(undefined, undefined)).toBe('app')
  })

  test('a view shows only when the surface knows the app and its host is there', () => {
    // WHY: a Manage page for an app on a host that went away would list old rows and send calls that fail.
    const known = app()
    expect(showsAppViews(appSurfacePhase(facts({ app: known })), known)).toBe(true)
    // No active version is not a reason to hide Manage: the owner deploys a revision there.
    const undeployed = app({ activeVersion: null })
    expect(showsAppViews(appSurfacePhase(facts({ app: undeployed, state: undefined, ui: undefined })), undeployed)).toBe(true)
    expect(showsAppViews(appSurfacePhase(facts({ hostPresent: false })), known)).toBe(false)
    expect(showsAppViews(appSurfacePhase(facts({ app: undefined, hostStatus: 'ready' })), undefined)).toBe(false)
  })
})

describe('the sections of the Manage page', () => {
  test('the rail and the strip list the same sections, in the order of the plan', () => {
    // WHY: the strip replaces the rail in a narrow pane. A section that one of them lacks cannot be reached there.
    expect(manageSections().map((section) => section.id)).toEqual([...APP_MANAGE_SECTIONS])
    expect(manageSections().map((section) => section.label)).toEqual([
      'Overview', 'Activity', 'Workflows', 'Versions', 'Schedules', 'Webhooks', 'Signals', 'Secrets', 'Files', 'Operations', 'Sessions', 'Source',
    ])
  })

  test('a section has the mark of the worst problem that leads to it', () => {
    const problems = appProblems(app({ attention: [
      { kind: 'secret-missing', detail: 'A is not set.' },
      { kind: 'workflow-failed', detail: 'A run failed.' },
      { kind: 'stopped', detail: 'The app is stopped.' },
    ] }))
    const marks = Object.fromEntries(manageSections(problems).map((section) => [section.id, section.problemTone]))
    expect(marks.secrets).toBe('warning')
    expect(marks.workflows).toBe('error')
    expect(marks.overview).toBeNull()
    expect(marks.versions).toBeNull()
  })

  test('the page opens on Overview, and the arrow keys stop at each end', () => {
    expect(manageSectionOf(undefined)).toBe('overview')
    expect(manageSectionOf('files')).toBe('files')
    expect(adjacentManageSection('overview', 1)).toBe('activity')
    expect(adjacentManageSection('overview', -1)).toBe('overview')
    expect(adjacentManageSection('source', 1)).toBe('source')
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
    // A row with an empty step is one execution of the workflow's function, not a call of a step.
    expect(callerText({ kind: 'workflow', runId: 'r1', workflow: 'build', step: '' })).toBe('Run of build')
    expect(callerText({ kind: 'workflow', runId: 'r1', workflow: 'build', step: 'save' })).toBe('Step save of build')
  })

  test('the delete confirmation names everything that goes with the app', () => {
    const text = appDeleteConfirmText('Notes')
    for (const lost of ['Notes', 'data', 'repository', 'schedules', 'secrets', 'webhooks']) expect(text).toContain(lost)
  })
})
