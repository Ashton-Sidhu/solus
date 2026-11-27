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
  manageToggleHint,
  problemsTone,
  showsAppViews,
  scheduleTriggerText,
  versionLabel,
  type AppSurfaceFacts,
} from '@solus/workspace-ui/components/app/lib/app-view'
import { adjacentManageSection, manageSectionCounts, manageSectionGroups, manageSectionOf, manageSections } from '@solus/workspace-ui/components/app/lib/app-manage'
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

  test('a run that failed on an older version is a warning with its run, so the owner retries or dismisses it in place', () => {
    // WHY: a deploy that fixed the bug left the old failure in red, as if the new code were broken.
    // The fix works; only the work waits. The row needs the run to act on it without opening Workflows.
    const stale = { kind: 'workflow-stale', detail: 'The last sync run failed on v1. v5 has not run it yet.', runId: 'run-1' } as const
    expect(appProblems(app({ attention: [stale] }))).toEqual([
      { kind: 'workflow-stale', detail: stale.detail, tone: 'warning', section: 'workflows', action: 'Open Workflows', runId: 'run-1' },
    ])
    expect(problemsTone(appProblems(app({ attention: [stale] })))).toBe('warning')
    expect(problemsTone(appProblems(app({ attention: [stale, { kind: 'workflow-failed', detail: 'A run failed.', runId: 'run-2' }] })))).toBe('error')
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
  test('the section list and the strip list the same sections, under four headings, in the order of the plan', () => {
    // WHY: the strip replaces the list in a narrow pane, and the arrow keys walk the route's order.
    // A section that a group lacks, or a group order that differs from the route's, cannot be reached in order.
    expect(manageSections().map((section) => section.label)).toEqual([
      'Overview', 'Activity', 'Workflows', 'Sessions', 'Schedules', 'Webhooks', 'Signals', 'Operations', 'Versions', 'Deployment', 'Secrets', 'Config', 'Files',
    ])
    const groups = manageSectionGroups()
    expect(groups.map((group) => group.label)).toEqual(['Run', 'Triggers', 'Build', 'Settings'])
    expect(groups.flatMap((group) => group.sections.map((section) => section.id))).toEqual([...APP_MANAGE_SECTIONS])
  })

  test('each section has its own icon, because the dock of a narrow pane names a section only by its icon', () => {
    // WHY: in the dock every section but the one on screen is its icon alone. Two sections with one icon cannot be told apart.
    const icons = manageSections().map((section) => section.icon)
    expect(icons.every(Boolean)).toBe(true)
    expect(new Set(icons).size).toBe(icons.length)
  })

  test('Source is not a section: its facts are on Overview', () => {
    expect((APP_MANAGE_SECTIONS as readonly string[]).includes('source')).toBe(false)
  })

  test('the page opens on Overview, and the arrow keys stop at each end', () => {
    expect(manageSectionOf(undefined)).toBe('overview')
    expect(manageSectionOf('files')).toBe('files')
    expect(adjacentManageSection('overview', 1)).toBe('activity')
    expect(adjacentManageSection('overview', -1)).toBe('overview')
    expect(adjacentManageSection('sessions', 1)).toBe('schedules')
    expect(adjacentManageSection('files', 1)).toBe('files')
  })

  test('a row counts what the app has, and a problem count replaces it in the colour of the worst problem', () => {
    // WHY: the owner scans the list for what needs them. A plain count in the place of a problem hides it.
    const descriptor = { workflows: [{}, {}], schedules: [{}], webhooks: [], signals: [{}] } as unknown as NonNullable<AppState['descriptor']>
    const state = { descriptor, secrets: [{}, {}] } as unknown as AppState
    const app = { failed24h: 3, operationCount: 6, latestVersion: 14 }
    const counts = manageSectionCounts(app, state, [
      { section: 'secrets', tone: 'warning' },
      { section: 'workflows', tone: 'warning' },
      { section: 'workflows', tone: 'error' },
    ])
    expect(counts.activity).toEqual({ count: 3, tone: 'error' })
    expect(counts.workflows).toEqual({ count: 2, tone: 'error' })
    expect(counts.secrets).toEqual({ count: 1, tone: 'warning' })
    expect(counts.schedules).toEqual({ count: 1, tone: null })
    expect(counts.operations).toEqual({ count: 6, tone: null })
    expect(counts.versions).toEqual({ count: 14, tone: null })
    // A section with none has no figure, not a zero.
    expect(counts.webhooks).toBeUndefined()
    expect(counts.overview).toBeUndefined()
  })

  test('before the host answers with the state, only the summary counts show, and no failed call is no figure', () => {
    const counts = manageSectionCounts({ failed24h: 0, operationCount: 2, latestVersion: null }, undefined, [])
    expect(counts).toEqual({ operations: { count: 2, tone: null } })
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

  test('a schedule names its trigger in words', () => {
    expect(scheduleTriggerText(schedule({}))).toBe('Every hour')
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
  test('the Manage button says what a press does and names the problems the header no longer marks with a dot', () => {
    expect(manageToggleHint({ isManage: false, shortcut: '⌥M', problemCount: 0 })).toBe('Manage (⌥M)')
    expect(manageToggleHint({ isManage: true, shortcut: '⌥M', problemCount: 0 })).toBe('Back to the app (⌥M)')
    expect(manageToggleHint({ isManage: false, shortcut: '', problemCount: 2 })).toBe('Manage · 2 problems')
  })
})
