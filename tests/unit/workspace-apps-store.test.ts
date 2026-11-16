import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { AppCallView, AppDeployReceipt, AppSessionLink, AppRevisionView, AppRunDetail, AppScheduleView, AppSignalView, AppState, AppSummary, AppUi } from '@solus/contracts/apps'
import type { HostApi } from '@solus/client-core/host-api'
import type { HostReadinessState } from '@solus/client-core/host-readiness'
import { serverConnections } from '@solus/client-core/server-connections'
import { AppsStore, type AppDeploy } from '@solus/workspace-ui/contexts/apps/apps.store.svelte'

function app(id: string, patch: Partial<AppSummary> = {}): AppSummary {
  return {
    id,
    slug: id,
    name: id,
    description: '',
    organizationId: 'local',
    activeVersion: 1,
    latestVersion: 1,
    latestRevision: 'a'.repeat(40),
    hasUndeployedRevision: false,
    buildingVersion: null,
    stopped: false,
    agentAccess: true,
    hasUi: true,
    operationCount: 1,
    project: '/repo',
    createdBy: { kind: 'system' },
    createdAt: 1,
    updatedAt: 1,
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
    network: [],
    permissionsNotice: null,
    runtime: { running: false, startedAt: null, inFlight: 0, rssBytes: null },
    repositoryPath: '/data/apps/repositories/notes.git',
  }
}

/** A promise a test settles when it chooses, to order two answers. */
function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Serve each host's reads from its own fake API. Every host is ready unless a test says otherwise. */
function stubHosts(apis: Record<string, Partial<HostApi>>, notReady: string[] = []): void {
  // SAFETY: each test gives the methods the store calls for its case.
  spyOn(serverConnections, 'apiFor').mockImplementation((serverId: string) => apis[serverId] as HostApi)
  spyOn(serverConnections, 'readinessFor').mockImplementation((serverId: string): HostReadinessState => ({
    readiness: notReady.includes(serverId) ? 'reconnecting' : 'ready',
    away: false,
    unreachableReason: null,
    refusedReason: null,
    lastSeenAt: null,
  }))
}

afterEach(() => mock.restore())

describe('the list of apps', () => {
  test('each host answers for its own apps, and a reload replaces what the host no longer has', async () => {
    // WHY: the list must never show an app as current after its host stopped listing it.
    let listed = [app('notes'), app('budget')]
    stubHosts({ a: { appList: async () => listed }, b: { appList: async () => [app('notes', { name: 'Notes on b' })] } })
    const store = new AppsStore()
    await Promise.all([store.load('a'), store.load('b')])
    expect(store.rows.map((row) => `${row.serverId}:${row.app.id}`)).toEqual(['a:budget', 'a:notes', 'b:notes'])

    listed = [app('notes')]
    await store.load('a')
    expect(store.rowsForHost('a').map((row) => row.app.id)).toEqual(['notes'])
    expect(store.rowsForHost('b')).toHaveLength(1)
  })

  test('a host that this client reaches through two connections lists each app once', async () => {
    // WHY: on web, `local` is a second connection to the primary host. The Apps tab showed every app twice.
    stubHosts({ a: { appList: async () => [app('notes')] }, local: { appList: async () => [app('notes')] }, b: { appList: async () => [app('notes')] } })
    // SAFETY: the store reads only the target's id of a connection.
    spyOn(serverConnections, 'connectionFor').mockImplementation((serverId: string) =>
      (serverId === 'local' ? { target: { id: 'a' } } : undefined) as ReturnType<typeof serverConnections.connectionFor>)
    const store = new AppsStore()
    await Promise.all([store.load('local'), store.load('a'), store.load('b')])

    expect(store.rows.map((row) => row.serverId)).toEqual(['a', 'b'])
    // A route that names the second connection still finds its app.
    expect(store.find('local', 'notes')?.app.id).toBe('notes')
  })

  test('a list read that started before a change does not put the old row back', async () => {
    // WHY: an event is newer than a read in flight. The read must not undo a deploy or a delete.
    const list = deferred<AppSummary[]>()
    stubHosts({ a: { appList: () => list.promise, appRead: async () => stateOf(app('notes')) } })
    const store = new AppsStore()
    const read = store.load('a')
    store.applyChange('a', { kind: 'saved', app: app('notes', { activeVersion: 2 }) })
    store.applyChange('a', { kind: 'saved', app: app('gone') })
    store.applyChange('a', { kind: 'deleted', appId: 'gone' })
    list.resolve([app('notes', { activeVersion: 1 }), app('gone')])
    await read

    expect(store.get('a', 'notes')?.app.activeVersion).toBe(2)
    expect(store.get('a', 'gone')).toBeUndefined()
  })

  test('a host that answers after it stopped being ready adds no rows', async () => {
    const list = deferred<AppSummary[]>()
    const notReady: string[] = []
    stubHosts({ a: { appList: () => list.promise } }, notReady)
    const store = new AppsStore()
    const read = store.load('a')
    notReady.push('a')
    list.resolve([app('notes')])
    await read
    expect(store.rows).toEqual([])
  })

  test('a host that refuses the read is unavailable, and the other hosts keep their rows', async () => {
    stubHosts({ old: { appList: async () => { throw new Error('unknown method') } }, a: { appList: async () => [app('notes')] } })
    const store = new AppsStore()
    const failed = spyOn(console, 'error').mockImplementation(() => {})
    await Promise.all([store.load('old'), store.load('a')])
    expect(failed).toHaveBeenCalled()
    expect(store.statusFor('old')).toBe('unavailable')
    expect(store.statusFor('a')).toBe('ready')
    expect(store.rows.map((row) => row.serverId)).toEqual(['a'])
  })

  test('a route finds its app by slug or by id, and a link with no host finds the host', async () => {
    stubHosts({ a: { appList: async () => [] }, b: { appList: async () => [app('app_1', { slug: 'notes' })] } })
    const store = new AppsStore()
    await Promise.all([store.load('a'), store.load('b')])
    expect(store.find('b', 'notes')?.app.id).toBe('app_1')
    expect(store.find('b', 'app_1')?.app.slug).toBe('notes')
    expect(store.find('a', 'notes')).toBeUndefined()
    expect(store.hostOf('notes')).toBe('b')
    expect(store.hostOf('missing')).toBeNull()
  })
})

describe('one app', () => {
  test('a change reads the state again when a view holds it, and a delete drops everything of the app', async () => {
    // WHY: a deploy changes the descriptor and the secrets a header shows. A deleted app must leave nothing a surface can draw.
    let version = 1
    const reads: string[] = []
    stubHosts({
      a: {
        appList: async () => [app('notes')],
        appRead: async ({ appId }) => {
          reads.push(appId)
          return { ...stateOf(app('notes', { activeVersion: version })), permissionsNotice: `v${version}` }
        },
        appUi: async (): Promise<AppUi> => ({ version, html: `<p>v${version}</p>` }),
      },
    })
    const store = new AppsStore()
    await store.load('a')
    store.applyChange('a', { kind: 'saved', app: app('notes') })
    expect(reads).toEqual([])

    await store.loadState('a', 'notes')
    await store.loadUi('a', 'notes', 1)
    version = 2
    store.applyChange('a', { kind: 'saved', app: app('notes', { activeVersion: 2 }) })
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toEqual(['notes', 'notes'])
    expect(store.stateFor('a', 'notes')?.permissionsNotice).toBe('v2')

    store.applyChange('a', { kind: 'deleted', appId: 'notes' })
    expect(store.get('a', 'notes')).toBeUndefined()
    expect(store.stateFor('a', 'notes')).toBeUndefined()
    expect(store.uiFor('a', 'notes', 1)).toBeUndefined()
  })

  test('a state read that a command overtook is dropped', async () => {
    // WHY: Stop answers with the new state. An older read that lands later must not show the app as running again.
    const slowRead = deferred<AppState>()
    stubHosts({
      a: {
        appRead: () => slowRead.promise,
        appStop: async () => stateOf(app('notes', { stopped: true })),
      },
    })
    const store = new AppsStore()
    const read = store.loadState('a', 'notes')
    await store.stop('a', 'notes')
    slowRead.resolve(stateOf(app('notes', { stopped: false })))
    await read

    expect(store.stateFor('a', 'notes')?.app.stopped).toBe(true)
    expect(store.get('a', 'notes')?.app.stopped).toBe(true)
  })

  test('a failed state read keeps its message until a read succeeds', async () => {
    let fail = true
    stubHosts({ a: { appRead: async () => { if (fail) throw new Error('The host refused.'); return stateOf(app('notes')) } } })
    const store = new AppsStore()
    await store.loadState('a', 'notes')
    expect(store.stateErrorFor('a', 'notes')).toBe('The host refused.')
    fail = false
    await store.loadState('a', 'notes')
    expect(store.stateErrorFor('a', 'notes')).toBeNull()
    expect(store.stateFor('a', 'notes')?.app.id).toBe('notes')
  })

  test('the UI is read once for a version and again for the next one', async () => {
    // WHY: the UI is one built file. A surface that opens twice must not read it twice, and a deploy must show the new one.
    let version = 1
    let reads = 0
    stubHosts({ a: { appUi: async (): Promise<AppUi> => ({ version, html: `<p>v${version}</p>` }) } })
    const counted = serverConnections.apiFor('a')
    const appUi = counted.appUi
    counted.appUi = async (request) => {
      reads++
      return appUi(request)
    }
    const store = new AppsStore()
    await Promise.all([store.loadUi('a', 'notes', 1), store.loadUi('a', 'notes', 1)])
    await store.loadUi('a', 'notes', 1)
    expect(reads).toBe(1)
    expect(store.uiFor('a', 'notes', 1)?.html).toBe('<p>v1</p>')
    // The frame asks for the version that is active now: the old file is not that version.
    expect(store.uiFor('a', 'notes', 2)).toBeUndefined()

    version = 2
    await store.loadUi('a', 'notes', 2)
    expect(reads).toBe(2)
    expect(store.uiFor('a', 'notes', 2)?.html).toBe('<p>v2</p>')
  })

  test('a version with no UI is read as none, not as still loading', async () => {
    stubHosts({ a: { appUi: async () => null } })
    const store = new AppsStore()
    expect(store.uiFor('a', 'notes', 1)).toBeUndefined()
    await store.loadUi('a', 'notes', 1)
    expect(store.uiFor('a', 'notes', 1)).toBeNull()
  })
})

describe('events of an app', () => {
  test('a data change raises the counter of that app only', () => {
    // WHY: an open frame runs its queries again when the counter rises. Another app's frame must not.
    const store = new AppsStore()
    expect(store.dataVersion('a', 'notes')).toBe(0)
    store.applyDataChange('a', 'notes')
    store.applyDataChange('a', 'notes')
    expect(store.dataVersion('a', 'notes')).toBe(2)
    expect(store.dataVersion('a', 'budget')).toBe(0)
    expect(store.dataVersion('b', 'notes')).toBe(0)
  })

  test('only a deploy by a session is told to the listeners: never a load, a reload, or another change', async () => {
    // WHY: the app's surface opens beside the conversation that deployed it. A list read must open nothing.
    stubHosts({ a: { appList: async () => [app('notes')] } })
    const store = new AppsStore()
    const deploys: AppDeploy[] = []
    const stop = store.onDeployed((deploy) => deploys.push(deploy))
    await store.load('a')
    await store.load('a')
    store.applyChange('a', { kind: 'saved', app: app('notes', { stopped: true }) })
    expect(deploys).toEqual([])

    store.applyChange('a', { kind: 'saved', app: app('notes', { activeVersion: 2 }), deployedBySessionId: 's1' })
    expect(deploys.map((deploy) => [deploy.serverId, deploy.sessionId, deploy.app.activeVersion])).toEqual([['a', 's1', 2]])

    stop()
    store.applyChange('a', { kind: 'saved', app: app('notes', { activeVersion: 3 }), deployedBySessionId: 's1' })
    expect(deploys).toHaveLength(1)
  })
})

describe('the sessions of an app', () => {
  const link = (sessionId: string, status: AppSessionLink['status']): AppSessionLink => ({
    sessionId,
    title: sessionId,
    linkedAt: 1,
    provider: 'claude-code',
    status,
    lastActivityAt: 1,
  })

  test('a session that starts or ends a run shows its new status at once, without a read', async () => {
    // WHY: the host writes the session's record after it sends the event, so a read
    // at that moment can still say Running. The row must follow the event.
    const appSessions = mock(async () => [link('s1', 'idle'), link('s2', 'idle')])
    stubHosts({ a: { appList: async () => [app('notes'), app('budget')], appSessions } })
    const store = new AppsStore()
    await store.load('a')
    await store.sessions.load('a', 'notes')

    store.applySessionStatus('a', { sessionId: 's1', agentSessionId: null, status: 'awaiting_input', at: 50 })
    expect(store.sessions.get('a', 'notes')?.map((row) => [row.sessionId, row.status, row.lastActivityAt])).toEqual([
      ['s1', 'running', 50],
      ['s2', 'idle', 1],
    ])
    store.applySessionStatus('a', { sessionId: 's1', agentSessionId: null, status: 'completed', at: 90 })
    expect(store.sessions.get('a', 'notes')?.[0].status).toBe('idle')
    expect(appSessions).toHaveBeenCalledTimes(1)

    // Another host's session of the same id, or an app that does not list it, changes nothing.
    store.applySessionStatus('b', { sessionId: 's2', agentSessionId: null, status: 'running', at: 99 })
    expect(store.sessions.get('a', 'notes')?.[1].status).toBe('idle')
    expect(store.sessions.get('a', 'budget')).toBeUndefined()
  })
})

describe('the lists of the Manage page', () => {
  const schedule = (enabled: boolean): AppScheduleView => ({
    name: 'digest',
    trigger: { type: 'interval', everyMinutes: 60 },
    run: 'sendDigest',
    enabled,
    nextRunAt: null,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
  })

  test('the answer of Pause is newer than a schedule read in flight', async () => {
    // WHY: a slow read that lands after Pause must not show the schedule as on.
    const slowRead = deferred<AppScheduleView[]>()
    stubHosts({ a: { appSchedules: () => slowRead.promise, appScheduleSet: async () => [schedule(false)] } })
    const store = new AppsStore()
    const read = store.schedules.load('a', 'notes')
    await store.setScheduleEnabled('a', 'notes', 'digest', false)
    slowRead.resolve([schedule(true)])
    await read
    expect(store.schedules.get('a', 'notes')?.[0]?.enabled).toBe(false)
  })

  test('a list that failed says why, and a list no view loaded is not read on a change', async () => {
    let scheduleReads = 0
    stubHosts({
      a: {
        appVersions: async () => { throw new Error('No answer.') },
        appSchedules: async () => { scheduleReads++; return [] },
      },
    })
    const store = new AppsStore()
    await store.versions.load('a', 'notes')
    expect(store.versions.get('a', 'notes')).toBeUndefined()
    expect(store.versions.errorFor('a', 'notes')).toBe('No answer.')

    store.applyChange('a', { kind: 'saved', app: app('notes') })
    await Promise.resolve()
    expect(scheduleReads).toBe(0)
  })
})

/** Lets the reads that an event started settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve()
}

function call(id: string, patch: Partial<AppCallView> = {}): AppCallView {
  return { id, version: 1, operation: 'list', caller: { kind: 'ui' }, startedAt: 1, finishedAt: 2, outcome: 'ok', error: null, durationMs: 1, logCount: 0, spanCount: 0, traceId: null, spanId: null, ...patch }
}

describe('the activity of an app', () => {
  /** Counts each read the store makes, by the method it calls. */
  function countedHost(extra: Partial<HostApi> = {}) {
    const reads: string[] = []
    const count = <Value>(name: string, value: Value) => async () => {
      reads.push(name)
      return value
    }
    stubHosts({
      a: {
        appCalls: async (request) => {
          reads.push(request.runId ? 'runCalls' : 'calls')
          return []
        },
        appCallRead: count('callDetail', null),
        appMetrics: count('metrics', { since: 0, calls: 0, failed: 0, p50Ms: null, p95Ms: null, hours: [], operations: [] }),
        appRuns: count('runs', []),
        appRunRead: count('runDetail', null),
        appSignals: count('signals', []),
        appSignalOccurrences: count('occurrences', []),
        appFiles: count('files', []),
        ...extra,
      },
    })
    return reads
  }

  test('each kind of activity reads again what a view shows of it, and nothing else', async () => {
    // WHY: the host says that an app's activity changed up to twice in one second. A Manage page that
    // shows the call log must not read the runs, the occurrences, and the files each time.
    const reads = countedHost()
    const store = new AppsStore()
    const release = [
      store.calls.watch('a', 'notes'), store.metrics.watch('a', 'notes'), store.runs.watch('a', 'notes'),
      store.signals.watch('a', 'notes'), store.files.watch('a', 'notes'),
    ]
    await settle()
    reads.length = 0

    store.applyActivity('a', { appId: 'notes', kinds: ['calls'] })
    await settle()
    expect(reads.sort()).toEqual(['calls', 'metrics'])

    reads.length = 0
    store.applyActivity('a', { appId: 'notes', kinds: ['runs'] })
    await settle()
    expect(reads).toEqual(['runs'])

    reads.length = 0
    store.applyActivity('a', { appId: 'notes', kinds: ['signals', 'files'] })
    await settle()
    // The live tail of a signal takes its occurrences from `apps.signalOccurred`, not from a read.
    expect(reads.sort()).toEqual(['files', 'signals'])

    // Another app's activity, and the same app on another host, read nothing here.
    reads.length = 0
    store.applyActivity('a', { appId: 'budget', kinds: ['calls', 'runs', 'signals', 'files'] })
    store.applyActivity('b', { appId: 'notes', kinds: ['calls'] })
    await settle()
    expect(reads).toEqual([])
    for (const stop of release) stop()
  })

  test('a list that no view shows now is not read, even when a view loaded it before', async () => {
    // WHY: a person opens the Manage page once and goes back to the app. An app that a schedule calls
    // each minute must not make this client read its call log for the rest of the day.
    const reads = countedHost()
    const store = new AppsStore()
    const release = store.calls.watch('a', 'notes')
    await settle()
    release()
    reads.length = 0

    store.applyActivity('a', { appId: 'notes', kinds: ['calls'] })
    await settle()
    expect(reads).toEqual([])
    // What the view read stays, so the page opens again on it while the next read runs.
    expect(store.calls.get('a', 'notes')).toEqual([])
  })

  test('the open call and the open run are read again with their lists', async () => {
    const reads = countedHost()
    const store = new AppsStore()
    const release = [store.callDetail.watch('a', 'notes', 'c1'), store.runDetail.watch('a', 'notes', 'r1'), store.runCalls.watch('a', 'notes', 'r1')]
    await settle()
    reads.length = 0

    store.applyActivity('a', { appId: 'notes', kinds: ['calls', 'runs'] })
    await settle()
    expect(reads.sort()).toEqual(['callDetail', 'runCalls', 'runDetail'])
    for (const stop of release) stop()
  })

  test('changes that come while a read is in flight make one more read, not one for each change', async () => {
    const answers: ReturnType<typeof deferred<AppCallView[]>>[] = []
    stubHosts({ a: { appCalls: () => { const answer = deferred<AppCallView[]>(); answers.push(answer); return answer.promise } } })
    const store = new AppsStore()
    const release = store.calls.watch('a', 'notes')
    for (let change = 0; change < 5; change++) store.applyActivity('a', { appId: 'notes', kinds: ['calls'] })
    expect(answers).toHaveLength(1)

    answers[0]!.resolve([call('old')])
    await settle()
    expect(answers).toHaveLength(2)
    answers[1]!.resolve([call('new')])
    await settle()
    expect(answers).toHaveLength(2)
    expect(store.calls.get('a', 'notes')?.map((row) => row.id)).toEqual(['new'])
    release()
  })

  test('the filters go to the host, and the rows of another filter are not shown under the new one', async () => {
    // WHY: the host applies the filters. Failed calls only, with the rows of every outcome still on screen, is a lie.
    const requests: object[] = []
    const failed = deferred<AppCallView[]>()
    stubHosts({ a: { appCalls: (request) => { requests.push(request); return request.outcome === 'failed' ? failed.promise : Promise.resolve([call('ok-1')]) } } })
    const store = new AppsStore()
    await store.calls.load('a', 'notes', { limit: 100 })
    expect(store.calls.get('a', 'notes')?.map((row) => row.id)).toEqual(['ok-1'])

    const read = store.calls.load('a', 'notes', { limit: 100, outcome: 'failed', operation: 'save', callerKind: 'schedule' })
    expect(store.calls.get('a', 'notes')).toBeUndefined()
    expect(requests.at(-1)).toEqual({ appId: 'notes', limit: 100, outcome: 'failed', operation: 'save', callerKind: 'schedule' })
    failed.resolve([call('failed-1', { outcome: 'failed' })])
    await read
    expect(store.calls.get('a', 'notes')?.map((row) => row.id)).toEqual(['failed-1'])
    // A view that opens again starts from the filters it left.
    expect(store.calls.queryFor('a', 'notes')).toEqual({ limit: 100, outcome: 'failed', operation: 'save', callerKind: 'schedule' })
  })

  test('the log of a run asks the host for the calls of that run', async () => {
    const requests: object[] = []
    stubHosts({ a: { appCalls: async (request) => { requests.push(request); return [call('exec', { operation: 'build', caller: { kind: 'workflow', runId: 'r1', workflow: 'build', step: '' } })] } } })
    const store = new AppsStore()
    await store.runCalls.load('a', 'notes', 'r1')
    expect(requests).toEqual([{ appId: 'notes', runId: 'r1', limit: 100 }])
    expect(store.runCalls.get('a', 'notes')?.[0]?.operation).toBe('build')
  })
})

describe('changes of an app that the Manage page shows', () => {
  const revision = (commit: string): AppRevisionView => ({ commit: commit.repeat(40), message: 'Save', savedAt: 1, versions: [] })

  test('a change of the app reads the revisions again, with the versions', async () => {
    // WHY: a save makes a revision and a deploy makes a version. The timeline of the Versions section joins the two.
    let revisions = [revision('a')]
    const reads: string[] = []
    stubHosts({
      a: {
        appRevisions: async () => { reads.push('revisions'); return revisions },
        appVersions: async () => { reads.push('versions'); return [] },
        appSignals: async () => { reads.push('signals'); return [] },
      },
    })
    const store = new AppsStore()
    await Promise.all([store.revisions.load('a', 'notes'), store.versions.load('a', 'notes')])
    reads.length = 0

    revisions = [revision('b'), revision('a')]
    store.applyChange('a', { kind: 'saved', app: app('notes', { hasUndeployedRevision: true }) })
    await settle()
    expect(reads.sort()).toEqual(['revisions', 'versions'])
    expect(store.revisions.get('a', 'notes')).toHaveLength(2)
  })

  test('a deploy answers with the app, and reads the timeline again', async () => {
    const receipt: AppDeployReceipt = { app: app('notes', { activeVersion: 2, latestVersion: 2 }), version: 2, active: true, error: null }
    const requests: object[] = []
    const reads: string[] = []
    stubHosts({
      a: {
        appDeploy: async (request) => { requests.push(request); return receipt },
        appRevisions: async () => { reads.push('revisions'); return [] },
        appVersions: async () => { reads.push('versions'); return [] },
      },
    })
    const store = new AppsStore()
    await Promise.all([store.revisions.load('a', 'notes'), store.versions.load('a', 'notes')])
    reads.length = 0

    expect(await store.deploy('a', 'notes', 'c'.repeat(40))).toBe(receipt)
    await settle()
    expect(requests).toEqual([{ appId: 'notes', commit: 'c'.repeat(40) }])
    expect(store.get('a', 'notes')?.app.activeVersion).toBe(2)
    expect(reads.sort()).toEqual(['revisions', 'versions'])

    // With no commit the host deploys the newest revision.
    await store.deploy('a', 'notes')
    expect(requests.at(-1)).toEqual({ appId: 'notes' })
  })

  test('the answer of a signal action is newer than a read of the signals in flight', async () => {
    const signal = (enabled: boolean): AppSignalView => ({
      name: 'report.ready', description: '', payload: {}, lastEmittedAt: null, count24h: 0,
      actions: [{ id: 'act_1', signal: 'report.ready', enabled, action: { type: 'notify', title: '', detail: '' } }],
    })
    const slowRead = deferred<AppSignalView[]>()
    const saves: object[] = []
    stubHosts({ a: { appSignals: () => slowRead.promise, appSignalActionSave: async (request) => { saves.push(request); return [signal(false)] } } })
    const store = new AppsStore()
    const read = store.signals.load('a', 'notes')
    await store.saveSignalAction('a', 'notes', 'report.ready', { type: 'notify', title: '', detail: '' }, false, 'act_1')
    slowRead.resolve([signal(true)])
    await read
    expect(store.signals.get('a', 'notes')?.[0]?.actions[0]?.enabled).toBe(false)
    expect(saves).toEqual([{ appId: 'notes', signal: 'report.ready', enabled: false, actionId: 'act_1', action: { type: 'notify', title: '', detail: '' } }])
  })

  test('Terminate answers with the run a view shows, and reads the list of runs again', async () => {
    const run = (state: AppRunDetail['state']): AppRunDetail => ({
      id: 'r1', workflow: 'build', state, startedAt: 1, updatedAt: 2, finishedAt: state === 'running' ? null : 3, wakeAt: null, error: null,
      startedBy: { kind: 'ui' }, stepCount: 0, input: '{}', result: null, key: null, steps: [],
    })
    let listReads = 0
    stubHosts({ a: { appRunRead: async () => run('running'), appRunTerminate: async () => run('terminated'), appRuns: async () => { listReads++; return [] } } })
    const store = new AppsStore()
    await store.runDetail.load('a', 'notes', 'r1')
    await store.terminateRun('a', 'notes', 'r1')
    await settle()
    expect(store.runDetail.get('a', 'notes')?.state).toBe('terminated')
    expect(listReads).toBe(1)
  })
})
