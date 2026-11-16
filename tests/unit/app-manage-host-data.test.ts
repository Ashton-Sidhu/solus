import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { appDescriptorSchema, appOperationCallName, appScheduleCalendarRequestSchema, type AppSpan } from '@solus/contracts/apps'
import { writeAppProject } from './helpers/app-project'
import { NOTES, REPORTS, call, change, dataDir, describeWithNode, eventually, host, installAppsHost, owner, project, save, schedulesModule, ship, store } from './helpers/apps-host'

installAppsHost()

describe('the rules of the Manage page host data', () => {
  test('a cron trigger plans its runs at its own times, and the request refuses a calendar that does not go up or is too long', () => {
    const weekdays = { type: 'cron' as const, expr: '0 9 * * 1', timezone: 'UTC' }
    const monday = Date.parse('2026-11-09T00:00:00Z')
    const week = 7 * 24 * 60 * 60_000
    expect(schedulesModule.plannedRuns(weekdays, monday, monday + week)).toBe(1)
    expect(schedulesModule.plannedRuns(weekdays, monday + 10 * 60 * 60_000, monday + week)).toBe(0)
    expect(schedulesModule.upcomingRuns(weekdays, Date.parse('2026-11-16T09:00:00Z'), 2)).toEqual([Date.parse('2026-11-16T09:00:00Z'), Date.parse('2026-11-23T09:00:00Z')])
    expect(appScheduleCalendarRequestSchema.safeParse({ appId: 'a', edges: [2, 1] }).success).toBe(false)
    expect(appScheduleCalendarRequestSchema.safeParse({ appId: 'a', edges: [0, 6 * week] }).success).toBe(false)
    expect(appScheduleCalendarRequestSchema.safeParse({ appId: 'a', edges: [0, week] }).success).toBe(true)
  })

  test('the tries of a step come from its spans across the executions of the run, the oldest first', async () => {
    const { stepTries } = await import('@solus/server/apps/app-step-tries')
    // WHY: a run that slept or a host that restarted runs the function again,
    // so the tries of one step are in more than one call of the run's log.
    const policy = { 'retry.limit': 3, 'retry.delay_ms': 2000, 'retry.backoff': 'exponential', 'step.timeout_ms': 30_000 }
    const span = (step: string, attempt: number, startMs: number, ok: boolean, detail?: string): AppSpan => ({ kind: 'step', name: step, startMs, durationMs: 100, ok, detail, attributes: { step, attempt, ...policy } })
    const calls = [
      { startedAt: 2_000, spans: [span('ask', 3, 10, true)] },
      { startedAt: 1_000, spans: [span('ask', 1, 0, false, 'timed out'), span('fetch', 1, 5, true), span('ask', 2, 300, false, 'timed out'), { kind: 'sql' as const, name: '2 statements', startMs: 0, durationMs: 1, ok: true }] },
    ]
    expect(stepTries(calls, 'ask')).toEqual({
      tries: [
        { attempt: 1, startedAt: 1_000, durationMs: 100, ok: false, error: 'timed out' },
        { attempt: 2, startedAt: 1_300, durationMs: 100, ok: false, error: 'timed out' },
        { attempt: 3, startedAt: 2_010, durationMs: 100, ok: true, error: null },
      ],
      retryPolicy: { limit: 3, delayMs: 2000, backoff: 'exponential', timeoutMs: 30_000 },
    })
    // A span from a runner before the retry options were written gives the tries with no policy.
    expect(stepTries([{ startedAt: 0, spans: [{ kind: 'step', name: 'old', startMs: 0, durationMs: 1, ok: true, attributes: { step: 'old', attempt: 1 } }] }], 'old').retryPolicy).toBeNull()
  })

  test('the preflight names what a revision adds and removes against the live version, and the secrets with no value', async () => {
    // The import waits for the helper: it puts the test SQLite in place before a server module loads.
    const { deployPreflight } = await import('@solus/server/apps/app-deploy-preflight')
    const live = appDescriptorSchema.parse({ solusApp: 4, name: 'Radar', permissions: { network: ['api.github.com'] }, webhooks: [], signals: [{ name: 'digest.ready', payload: {} }] })
    const next = appDescriptorSchema.parse({
      solusApp: 4, name: 'Radar', permissions: { network: ['api.github.com', 'hooks.slack.com'], files: { read: ['~/Notes'] } },
      secrets: [{ name: 'SLACK_WEBHOOK_URL', label: 'Slack URL' }, { name: 'GITHUB_TOKEN', label: 'GitHub token' }],
      config: [{ name: 'model', label: 'Model', type: 'model', default: '' }],
    })
    const preflight = deployPreflight('a'.repeat(40), { number: 14, descriptor: live }, { descriptor: next }, { GITHUB_TOKEN: 'set' })
    expect(preflight).toMatchObject({
      against: 14,
      buildError: null,
      network: { added: ['hooks.slack.com'], removed: [] },
      readPaths: { added: ['~/Notes'], removed: [] },
      models: { added: ['model'], removed: [] },
      signals: { added: [], removed: ['digest.ready'] },
      secretsMissing: [{ name: 'SLACK_WEBHOOK_URL', label: 'Slack URL' }],
    })
    // With no live version, everything the revision declares is new.
    expect(deployPreflight('a'.repeat(40), null, { descriptor: live }, {}).network.added).toEqual(['api.github.com'])
    // A revision that does not build changes nothing it can name.
    expect(deployPreflight('a'.repeat(40), { number: 14, descriptor: live }, { buildError: 'The build failed: x' }, {})).toMatchObject({ buildError: 'The build failed: x', network: { added: [], removed: [] }, secretsMissing: [] })
  })
})

/**
 * What the Manage page reads from the host for Workflows, Schedules, and
 * Versions (docs/plans/apps.md §9.2): the tries of a step, the calendar of
 * the schedules, and the deploy preflight.
 */
describeWithNode('the host data of the Manage page', () => {
  test('a step says each try with its outcome and its retry options, from the run log', async () => {
    // WHY: the receipt of a step keeps only how many tries it took. The owner
    // reads why each try failed, and how the step tries again, to repair it.
    const { apps, workflows } = await host()
    const { app } = await ship(apps, project(REPORTS))
    const started = await call(apps, app.id, appOperationCallName('request'), { title: 'Bad', fail: true })
    const failed = await eventually(async () => {
      const detail = await workflows.read(owner, app.id, started.id)
      return detail?.state === 'failed' ? detail : null
    }, 'the run failed')
    const [count] = failed.steps
    expect(count.tries).toEqual([{ attempt: 1, startedAt: expect.any(Number), durationMs: expect.any(Number), ok: false, error: 'the source is gone' }])
    expect(count.retryPolicy).toEqual({ limit: 0, delayMs: 1000, backoff: 'constant', timeoutMs: expect.any(Number) })
  })

  test('the calendar counts the runs of each schedule in each span the client asks for, and names the runs to come', async () => {
    // WHY: a schedule that runs every 15 minutes runs 672 times a week, more
    // than a page of the call log. The host counts, so the calendar is true.
    const apps = (await host()).apps
    const now = Date.parse('2026-11-12T10:00:00Z')
    const schedules = new schedulesModule.AppSchedules(apps, () => now)
    apps.addLifecyclePart(schedules)
    const { app } = await ship(apps, project(NOTES))
    const day = 24 * 60 * 60_000
    const monday = Date.parse('2026-11-09T00:00:00Z')
    const runs: [number, 'ok' | 'failed'][] = [[monday + 60_000, 'ok'], [monday + 2 * 60_000, 'failed'], [monday + day + 60_000, 'ok']]
    for (const [index, [startedAt, outcome]] of runs.entries()) {
      const id = `call-${index}`
      await store.insertCall({ id, appId: app.id, version: 1, kind: 'operation', operation: 'add', caller: { kind: 'schedule', name: 'tick' }, startedAt, input: '{}', inputTruncated: false, runId: null, traceId: null, spanId: null })
      await store.finishCall(id, { outcome, error: outcome === 'failed' ? 'no' : null, errorStack: null, resultBytes: 0, logs: [], logsTruncated: false, spans: [], finishedAt: startedAt + 10 })
    }
    // A call of a person is not a run of the schedule.
    await call(apps, app.id, appOperationCallName('add'), { text: 'by hand' })

    const edges = [monday, monday + day, monday + 2 * day, monday + 3 * day]
    const calendar = await schedules.calendar(owner, app.id, edges)
    expect(calendar).toMatchObject({ edges, keptSince: null })
    expect(calendar.lanes).toHaveLength(1)
    const [tick] = calendar.lanes
    expect(tick.name).toBe('tick')
    // `tick` runs every 5 minutes: 288 planned runs in a day.
    expect(tick.spans).toEqual([
      { ok: 1, failed: 1, running: 0, planned: 288, lastRunAt: monday + 2 * 60_000, lastOutcome: 'failed' },
      { ok: 1, failed: 0, running: 0, planned: 288, lastRunAt: monday + day + 60_000, lastOutcome: 'ok' },
      { ok: 0, failed: 0, running: 0, planned: 288, lastRunAt: null, lastOutcome: null },
    ])
    expect(tick.upcoming).toEqual([1, 2, 3, 4, 5].map((step) => now + step * 5 * 60_000))

    // A paused schedule has no run to come.
    await schedules.set(owner, app.id, 'tick', false)
    expect((await schedules.calendar(owner, app.id, edges)).lanes[0].upcoming).toEqual([])
    schedules.stop()
  })

  test('the preflight says what a deploy of a revision changes against the live version, and makes no version', async () => {
    // WHY: a deploy runs at once with the app's data. The owner must see a new
    // network host, a secret with no value, and a lost webhook before, not after.
    const { apps, builder } = await host()
    const { AppRepositories } = await import('@solus/server/apps/app-repository')
    const { AppDeployPreflights } = await import('@solus/server/apps/app-deploy-preflight')
    const preflights = new AppDeployPreflights({ apps, builder, repositories: new AppRepositories(() => join(dataDir, 'apps', 'repositories')) }, () => ({}))
    const folder = project(NOTES)
    const shipped = await ship(apps, folder)
    const next = NOTES.app
      .replace("secrets: { token: { label: 'API token' } },", "secrets: { token: { label: 'API token' }, slack: { label: 'Slack URL' } },\n  permissions: { network: ['hooks.slack.com'] },")
      .replace("  webhooks: { pushed: { verify: { scheme: 'token', source: { kind: 'header', name: 'x-token' } }, run: 'add' } },\n", '')
    writeAppProject(folder, { ...NOTES, app: next })
    const saved = await save(apps, folder)
    const buildsBefore = builder.revisionBuilds

    const preflight = await preflights.preflight(owner, shipped.app.id, saved.revision)
    expect(preflight).toMatchObject({
      commit: saved.revision,
      against: 1,
      buildError: null,
      network: { added: ['hooks.slack.com'], removed: [] },
      webhooks: { added: [], removed: ['pushed'] },
      schedules: { added: [], removed: [] },
      secretsMissing: [{ name: 'token', label: 'API token' }, { name: 'slack', label: 'Slack URL' }],
    })
    expect(builder.revisionBuilds).toBe(buildsBefore + 1)
    // A revision does not change: a second ask builds nothing, and no version was made.
    await preflights.preflight(owner, shipped.app.id, saved.revision)
    expect(builder.revisionBuilds).toBe(buildsBefore + 1)
    expect((await apps.versions(owner, shipped.app.id)).map((version) => version.number)).toEqual([1])

    // The revision of the live version has its version's descriptor, with no build, and changes nothing.
    const live = await preflights.preflight(owner, shipped.app.id, shipped.revision)
    expect(live.network).toEqual({ added: [], removed: [] })
    expect(builder.revisionBuilds).toBe(buildsBefore + 1)

    // A revision that does not build says why, and the deploy would fail the same way.
    const broken = await change(apps, folder, { ...NOTES, app: 'export default defineApp({' })
    const failed = await preflights.preflight(owner, shipped.app.id, broken.revision)
    expect(failed.buildError).toContain('The build failed')
    await expect(preflights.preflight(owner, shipped.app.id, 'f'.repeat(40))).rejects.toThrow('This app has no such revision.')
  })
})
