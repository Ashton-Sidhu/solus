import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { AppScheduleView, AppState, AppSummary, AppUi } from '@solus/contracts/apps'
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
    stopped: false,
    hasUi: true,
    operationCount: 1,
    project: '/repo',
    createdBy: { kind: 'system' },
    createdAt: 1,
    updatedAt: 1,
    lastCallAt: null,
    attention: [],
    ...patch,
  }
}

function stateOf(summary: AppSummary): AppState {
  return { app: summary, descriptor: null, roles: [], secrets: [], network: [], permissionsNotice: null }
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

describe('the lists of the app menu', () => {
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
