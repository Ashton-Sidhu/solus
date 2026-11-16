import { SvelteMap } from 'svelte/reactivity'
import type {
  AppActivityEvent,
  AppBuildLog,
  AppCallDetail,
  AppCallStats,
  AppCallView,
  AppCallsRequest,
  AppConfigValue,
  AppDeployPreflight,
  AppDeployReceipt,
  AppFileView,
  AppMetrics,
  AppRevisionDiff,
  AppRevisionView,
  AppRunDetail,
  AppRunView,
  AppRunsRequest,
  AppScheduleCalendar,
  AppScheduleView,
  AppStepSource,
  AppStepSourceRequest,
  AppSessionLink,
  AppSignalAction,
  AppSignalActionSaveRequest,
  AppSignalView,
  AppState,
  AppSummary,
  AppUi,
  AppUpdate,
  AppVersionDiff,
  AppVersionView,
  AppWebhookView,
  AppsChangedEvent,
} from '@solus/contracts/apps'
import type { AppDeploymentView, AppPublishPlaces, AppPublishReceipt, AppPublishRequest } from '@solus/contracts/app-deployments'
import type { AppModelCallView } from '@solus/contracts/app-models'
import type { HostEventMap } from '@solus/contracts/host-events'
import { sessionRecordStatusOf } from '@solus/contracts/types'
import { isSolusApiId } from '@solus/contracts/uplink'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { AppResource, appKey } from './app-resource.svelte'
import { AppSignalTails } from './app-signal-tail.svelte'

/**
 * Every app this client can see (docs/plans/apps.md §9), read from each
 * connected host and joined into one list. Each row names its host. A host
 * that is not ready has no rows here: the list never shows old rows as
 * current. `apps.changed` keeps the rows fresh, `apps.dataChanged` raises the
 * app's data version, `apps.activity` reads again what a Manage page shows,
 * and a reconnect reads the host again.
 */

/** `unavailable`: the host answered with an error, for example an older host without apps. */
export type AppHostStatus = 'loading' | 'ready' | 'unavailable'

/** One app in a list, with the host it lives on. */
export interface AppRow {
  serverId: string
  app: AppSummary
}

/** An agent's deploy made or changed an app. */
export interface AppDeploy {
  serverId: string
  sessionId: string
  app: AppSummary
}

/** The UI of one version. `ui` is null for a version that has no UI. */
interface AppUiRead {
  version: number
  ui: AppUi | null
}

/** The filters of the call log, and how many calls a view reads. */
export type AppCallQuery = Pick<AppCallsRequest, 'operation' | 'outcome' | 'callerKind' | 'search' | 'kind' | 'since' | 'until' | 'match' | 'limit'>
/** The filters of the Activity chart: the call log's, without a page size. */
export type AppCallStatsQuery = Omit<AppCallQuery, 'limit'>
export type AppRunQuery = Pick<AppRunsRequest, 'state'>
/** The step whose `step.do` call the source view finds; `version` absent is the active version. */
export type AppStepSourceQuery = Pick<AppStepSourceRequest, 'workflow' | 'step' | 'version'>

/** The call log a Manage page reads at one time. */
const CALL_PAGE = 100
/** The failed calls the Overview lists. */
const FAILED_CALL_PAGE = 5
/** The newest succeeded runs a workflow's last good run is looked for in. */
const GOOD_RUN_PAGE = 50
/** The most the host gives in one read: enough for the strips of several schedules. */
const SCHEDULE_CALL_PAGE = 500

export class AppsStore {
  /** Keyed by host and app id: two hosts can hold the same id. */
  private readonly entries = new SvelteMap<string, AppRow>()
  private readonly hostStatus = new SvelteMap<string, AppHostStatus>()
  private readonly states = new SvelteMap<string, AppState>()
  private readonly stateErrors = new SvelteMap<string, string>()
  private readonly uis = new SvelteMap<string, AppUiRead>()
  private readonly uiErrors = new SvelteMap<string, string>()
  private readonly dataVersions = new SvelteMap<string, number>()
  /** The places a first publish offers and what a host has for a publish (docs/plans/app-deploy.md §9), by host. */
  private readonly publishPlaces = new SvelteMap<string, AppPublishPlaces>()
  /** Rises with each change of an app. A list read that started before an app's change does not put its old row back. */
  private changeCount = 0
  private readonly changedAt = new Map<string, number>()
  private readonly stateReads = new Map<string, number>()
  private readonly statesInFlight = new Set<string>()
  private readonly uiReads = new Map<string, number>()
  /** The version each UI read in flight asked for. */
  private readonly uisInFlight = new Map<string, number>()
  private readonly deployListeners = new Set<(deploy: AppDeploy) => void>()
  private watchCount = 0
  private stopWatching: (() => void) | null = null

  // What the active version declares, and the app's history: `apps.changed` reads them again.
  readonly versions = new AppResource<AppVersionView[]>((api, appId) => api.appVersions({ appId }), null)
  readonly revisions = new AppResource<AppRevisionView[]>((api, appId) => api.appRevisions({ appId }), null)
  readonly schedules = new AppResource<AppScheduleView[]>((api, appId) => api.appSchedules({ appId }), null)
  readonly webhooks = new AppResource<AppWebhookView[]>((api, appId) => api.appWebhooks({ appId }), null)
  readonly sessions = new AppResource<AppSessionLink[]>((api, appId) => api.appSessions({ appId }), null)
  // What the app did: `apps.activity` reads again the ones a view shows.
  readonly metrics = new AppResource<AppMetrics>((api, appId) => api.appMetrics({ appId }), null)
  readonly calls = new AppResource<AppCallView[], AppCallQuery>((api, appId, query) => api.appCalls({ appId, limit: CALL_PAGE, ...query }), {})
  /** The numbers of every call that passes the call log's filters: the Activity chart. */
  readonly callStats = new AppResource<AppCallStats, AppCallStatsQuery>((api, appId, query) => api.appCallStats({ appId, ...query }), {})
  /** The newest runs of the app's schedules, for the run strip of each one. Apart from `calls`, so the call log keeps its filters. */
  readonly scheduleCalls = new AppResource<AppCallView[]>((api, appId) => api.appCalls({ appId, callerKind: 'schedule', limit: SCHEDULE_CALL_PAGE }), null)
  /** The newest failed calls, for the Overview. Apart from `calls`, so the call log keeps its filters. */
  readonly failedCalls = new AppResource<AppCallView[]>((api, appId) => api.appCalls({ appId, outcome: 'failed', limit: FAILED_CALL_PAGE }), null)
  /** One call with its input, log lines, and trace. The query is the call's id. */
  readonly callDetail = new AppResource<AppCallDetail | null, string | null>(
    async (api, appId, callId) => (callId ? api.appCallRead({ appId, callId }) : null), null)
  readonly runs = new AppResource<AppRunView[], AppRunQuery>((api, appId, query) => api.appRuns({ appId, ...query }), {})
  /** One run with its steps. The query is the run's id. */
  readonly runDetail = new AppResource<AppRunDetail | null, string | null>(
    async (api, appId, runId) => (runId ? api.appRunRead({ appId, runId }) : null), null)
  /** Where one step of a workflow is in the source of a version, with that file's text. Null when the source has no such step. */
  readonly stepSource = new AppResource<AppStepSource | null, AppStepSourceQuery | null>(
    async (api, appId, query) => (query ? api.appStepSource({ appId, ...query }) : null), null)
  /** The log of one run: the executions of its function and the calls of its steps. The query is the run's id. */
  readonly runCalls = new AppResource<AppCallView[], string | null>(
    async (api, appId, runId) => (runId ? api.appCalls({ appId, runId, limit: CALL_PAGE }) : []), null)
  /** The newest run of one workflow that succeeded, for the steps a run that stopped early did not reach. The query is the workflow's name. */
  readonly lastGoodRun = new AppResource<AppRunDetail | null, string | null>(async (api, appId, workflow) => {
    if (!workflow) return null
    const good = (await api.appRuns({ appId, state: 'succeeded', limit: GOOD_RUN_PAGE })).find((run) => run.workflow === workflow)
    return good ? api.appRunRead({ appId, runId: good.id }) : null
  }, null)
  /** The runs of each schedule in each span of the calendar. The query is the edges of the spans, in the client's time. */
  readonly scheduleCalendar = new AppResource<AppScheduleCalendar | null, number[] | null>(
    async (api, appId, edges) => (edges ? api.appScheduleCalendar({ appId, edges }) : null), null)
  /** What a deploy of one revision changes against the active version. The query is the revision's commit. */
  readonly deployPreflight = new AppResource<AppDeployPreflight | null, string | null>(
    async (api, appId, commit) => (commit ? api.appDeployPreflight({ appId, commit }) : null), null)
  readonly signals = new AppResource<AppSignalView[]>((api, appId) => api.appSignals({ appId }), null)
  /** The live tail of each signal a view shows: `apps.signalOccurred` keeps it fresh. */
  readonly signalTails = new AppSignalTails()
  readonly files = new AppResource<AppFileView[]>((api, appId) => api.appFiles({ appId }), null)
  /** One model call with its text, steps, and result. The query is the call's id. */
  readonly modelCallDetail = new AppResource<AppModelCallView | null, string | null>(
    async (api, appId, callId) => (callId ? api.appModelCallRead({ appId, callId }) : null), null)
  /** The published copy of the app (docs/plans/app-deploy.md); null for an app that is not published. */
  readonly deployment = new AppResource<AppDeploymentView | null>((api, appId) => api.appDeployment({ appId }), null)
  /** The newest lines of the deployment's own log. */
  readonly deploymentLog = new AppResource<string>((api, appId) => api.appDeploymentLogs({ appId }), null)

  private readonly resources: readonly { drop(key: string): void }[] = [
    this.versions, this.revisions, this.schedules, this.webhooks, this.sessions, this.metrics, this.calls, this.callStats, this.scheduleCalls,
    this.callDetail, this.runs, this.runDetail, this.runCalls, this.lastGoodRun, this.scheduleCalendar, this.deployPreflight, this.signals, this.files,
    this.modelCallDetail, this.deployment, this.deploymentLog, this.stepSource,
  ]

  /** Surfaces that show apps hold one shared watch over every host. */
  watch(): () => void {
    if (this.watchCount++ === 0) {
      const stopChanged = subscribeAllHosts('apps.changed', (serverId, event) => this.applyChange(serverId, event))
      const stopData = subscribeAllHosts('apps.dataChanged', (serverId, change) => this.applyDataChange(serverId, change.appId))
      const stopActivity = subscribeAllHosts('apps.activity', (serverId, activity) => this.applyActivity(serverId, activity))
      const stopSessionStatus = subscribeAllHosts('session.statusChanged', (serverId, event) => this.applySessionStatus(serverId, event))
      const stopReadiness = serverConnections.onReadinessChange((serverId, status) => {
        if (isSolusApiId(serverId)) return
        if (status === 'ready') void this.load(serverId)
        else this.forgetHost(serverId)
      })
      this.stopWatching = () => { stopChanged(); stopData(); stopActivity(); stopSessionStatus(); stopReadiness() }
      void this.loadAll()
    }
    return () => {
      if (--this.watchCount > 0) return
      this.stopWatching?.()
      this.stopWatching = null
    }
  }

  private machineIds(): string[] {
    return serverConnections.connectedServerIds().filter((serverId) => !isSolusApiId(serverId))
  }

  // ─── Answers ───

  /**
   * Every app once, sorted by name, then by host. A client can hold two
   * connections to one host (on web, `local` is a second connection to the
   * primary host) and it then reads each app twice: the row under the host's
   * own id stays.
   */
  get rows(): AppRow[] {
    const rows = new Map<string, AppRow>()
    for (const row of this.entries.values()) {
      const hostId = serverConnections.connectionFor(row.serverId)?.target.id ?? row.serverId
      const key = appKey(hostId, row.app.id)
      if (!rows.has(key) || row.serverId === hostId) rows.set(key, row)
    }
    return [...rows.values()].sort((a, b) => a.app.name.localeCompare(b.app.name) || a.serverId.localeCompare(b.serverId))
  }

  /** The rows read through one connection, for a route that names it. */
  rowsForHost(serverId: string): AppRow[] {
    return [...this.entries.values()]
      .filter((row) => row.serverId === serverId)
      .sort((a, b) => a.app.name.localeCompare(b.app.name))
  }

  /** Whether any host still reads its first list. */
  get isLoading(): boolean {
    return [...this.hostStatus.values()].includes('loading')
  }

  /** Whether one host or more answered and none still reads: an app no row names is on no connected host. */
  get isSettled(): boolean {
    return this.hostStatus.size > 0 && !this.isLoading
  }

  statusFor(serverId: string): AppHostStatus | null {
    return this.hostStatus.get(serverId) ?? null
  }

  get(serverId: string, appId: string): AppRow | undefined {
    return this.entries.get(appKey(serverId, appId))
  }

  /** The app a route names on one host: by its slug, or by its id. */
  find(serverId: string, slugOrId: string): AppRow | undefined {
    return this.get(serverId, slugOrId) ?? this.rowsForHost(serverId).find((row) => row.app.slug === slugOrId)
  }

  /** The first host that has the app, for a link that names no host. */
  hostOf(slugOrId: string): string | null {
    return this.rows.find((row) => row.app.slug === slugOrId || row.app.id === slugOrId)?.serverId ?? null
  }

  stateFor(serverId: string, appId: string): AppState | undefined {
    return this.states.get(appKey(serverId, appId))
  }

  stateErrorFor(serverId: string, appId: string): string | null {
    return this.stateErrors.get(appKey(serverId, appId)) ?? null
  }

  /** The UI of `version`: its HTML, null when the version has none, undefined until it is read. */
  uiFor(serverId: string, appId: string, version: number | null): AppUi | null | undefined {
    const read = this.uis.get(appKey(serverId, appId))
    return read && read.version === version ? read.ui : undefined
  }

  uiErrorFor(serverId: string, appId: string): string | null {
    return this.uiErrors.get(appKey(serverId, appId)) ?? null
  }

  /** Rises each time a mutation changed the app's data. An open frame runs its queries again. */
  dataVersion(serverId: string, appId: string): number {
    return this.dataVersions.get(appKey(serverId, appId)) ?? 0
  }

  /** Hear each deploy an agent made. Never a load or a reload. */
  onDeployed(listener: (deploy: AppDeploy) => void): () => void {
    this.deployListeners.add(listener)
    return () => this.deployListeners.delete(listener)
  }

  // ─── Reads ───

  /** Read the list of every machine that is ready. */
  async loadAll(): Promise<void> {
    await Promise.all(this.machineIds()
      .filter((serverId) => serverConnections.readinessFor(serverId).readiness === 'ready')
      .map((serverId) => this.load(serverId)))
  }

  /** Read one host's list and replace its rows. */
  async load(serverId: string): Promise<void> {
    const startedAt = this.changeCount
    if (!this.hostStatus.has(serverId)) this.hostStatus.set(serverId, 'loading')
    try {
      const list = await serverConnections.apiFor(serverId).appList()
      if (serverConnections.readinessFor(serverId).readiness !== 'ready') return
      const liveKeys = new Set<string>()
      for (const app of list) {
        const key = appKey(serverId, app.id)
        liveKeys.add(key)
        if ((this.changedAt.get(key) ?? 0) > startedAt) continue
        this.entries.set(key, { serverId, app })
      }
      for (const [key, row] of this.entries) {
        if (row.serverId !== serverId || liveKeys.has(key)) continue
        if ((this.changedAt.get(key) ?? 0) > startedAt) continue
        this.dropApp(key)
      }
      this.hostStatus.set(serverId, 'ready')
    } catch (error) {
      console.error('app list host load failed', serverId, error)
      this.hostStatus.set(serverId, 'unavailable')
    }
  }

  /**
   * Read what a surface that shows the app needs: its state once, and the UI
   * of its active version. A failed read stays failed until `reload`. Call
   * from an effect that reads the app's row, so a new version reads its UI.
   */
  ensure(serverId: string, appId: string): void {
    const key = appKey(serverId, appId)
    const app = this.entries.get(key)?.app
    if (!app) return
    this.ensureState(serverId, appId)
    if (app.hasUi && app.activeVersion !== null && !this.uiErrors.has(key)) void this.loadUi(serverId, appId, app.activeVersion)
  }

  /** Read the app's state once: what a view needs that reads its descriptor or its secrets. */
  ensureState(serverId: string, appId: string): void {
    const key = appKey(serverId, appId)
    if (!this.entries.has(key)) return
    if (!this.states.has(key) && !this.stateErrors.has(key) && !this.statesInFlight.has(key)) void this.loadState(serverId, appId)
  }

  /** The retry after a failed read: the host's list, then the app's state and UI. */
  async reload(serverId: string, slugOrId: string): Promise<void> {
    await this.load(serverId)
    const app = this.find(serverId, slugOrId)?.app
    if (!app) return
    const key = appKey(serverId, app.id)
    this.uiErrors.delete(key)
    await Promise.all([
      this.loadState(serverId, app.id),
      app.hasUi && app.activeVersion !== null ? this.loadUi(serverId, app.id, app.activeVersion) : null,
    ])
  }

  /** Read one app's state. A read that a newer read or a command overtook is dropped. */
  async loadState(serverId: string, appId: string): Promise<void> {
    const key = appKey(serverId, appId)
    const read = (this.stateReads.get(key) ?? 0) + 1
    this.stateReads.set(key, read)
    this.statesInFlight.add(key)
    try {
      const state = await serverConnections.apiFor(serverId).appRead({ appId })
      if (this.stateReads.get(key) !== read) return
      this.putState(serverId, state)
    } catch (error) {
      if (this.stateReads.get(key) !== read) return
      this.stateErrors.set(key, error instanceof Error && error.message ? error.message : 'Could not load this app.')
    } finally {
      if (this.stateReads.get(key) === read) this.statesInFlight.delete(key)
    }
  }

  /** Read the UI of the active version, unless the kept one already is that version. */
  async loadUi(serverId: string, appId: string, version: number): Promise<void> {
    const key = appKey(serverId, appId)
    if (this.uis.get(key)?.version === version || this.uisInFlight.get(key) === version) return
    const read = (this.uiReads.get(key) ?? 0) + 1
    this.uiReads.set(key, read)
    this.uisInFlight.set(key, version)
    try {
      const ui = await serverConnections.apiFor(serverId).appUi({ appId })
      if (this.uiReads.get(key) !== read) return
      this.uiErrors.delete(key)
      // The host answers for the version that is active now, which a deploy can have moved.
      this.uis.set(key, { version: ui?.version ?? version, ui })
    } catch (error) {
      if (this.uiReads.get(key) !== read) return
      this.uiErrors.set(key, error instanceof Error && error.message ? error.message : 'Could not load the UI of this app.')
    } finally {
      if (this.uiReads.get(key) === read) this.uisInFlight.delete(key)
    }
  }

  /** The source change of one version. Read when a view opens it; not kept. */
  versionDiff(serverId: string, appId: string, version: number): Promise<AppVersionDiff> {
    return serverConnections.apiFor(serverId).appVersionDiff({ appId, version })
  }

  /** The source change of one revision, against the revision before it or against `against`. Read when a view opens it; not kept. */
  revisionDiff(serverId: string, appId: string, commit: string, against?: string): Promise<AppRevisionDiff> {
    return serverConnections.apiFor(serverId).appRevisionDiff(against ? { appId, commit, against } : { appId, commit })
  }

  /** The text of one version's build. Read when a view opens it; not kept. */
  buildLog(serverId: string, appId: string, version: number): Promise<AppBuildLog> {
    return serverConnections.apiFor(serverId).appBuildLog({ appId, version })
  }

  // ─── Events ───

  applyChange(serverId: string, event: AppsChangedEvent): void {
    if (event.kind === 'deleted') {
      const key = appKey(serverId, event.appId)
      this.changedAt.set(key, ++this.changeCount)
      this.dropApp(key)
      return
    }
    const { app } = event
    this.put(serverId, app)
    // What a view loaded can be old now: the descriptor, the secrets, and what the Manage page lists of a version.
    if (this.states.has(appKey(serverId, app.id))) void this.loadState(serverId, app.id)
    this.versions.reloadIfLoaded(serverId, app.id)
    this.revisions.reloadIfLoaded(serverId, app.id)
    // A new active version can move a step.
    this.stepSource.reloadIfLoaded(serverId, app.id)
    this.schedules.reloadIfLoaded(serverId, app.id)
    this.scheduleCalendar.reloadIfLoaded(serverId, app.id)
    this.deployPreflight.reloadIfLoaded(serverId, app.id)
    this.webhooks.reloadIfLoaded(serverId, app.id)
    this.sessions.reloadIfLoaded(serverId, app.id)
    this.signals.reloadIfLoaded(serverId, app.id)
    if (event.deployedBySessionId) {
      const deploy: AppDeploy = { serverId, sessionId: event.deployedBySessionId, app }
      for (const listener of this.deployListeners) listener(deploy)
    }
  }

  applyDataChange(serverId: string, appId: string): void {
    const key = appKey(serverId, appId)
    this.dataVersions.set(key, (this.dataVersions.get(key) ?? 0) + 1)
  }

  /**
   * A session's run started or ended. Each app that lists it takes the new
   * status at once: the host writes the session's record after it sends the
   * event, so a read now can still give the old status.
   */
  applySessionStatus(serverId: string, event: HostEventMap['session.statusChanged']): void {
    const status = sessionRecordStatusOf(event.status)
    for (const row of this.entries.values()) {
      if (row.serverId !== serverId) continue
      const links = this.sessions.get(serverId, row.app.id)
      if (!links?.some((link) => link.sessionId === event.sessionId)) continue
      this.sessions.accept(serverId, row.app.id, links.map((link) =>
        link.sessionId === event.sessionId ? { ...link, status, lastActivityAt: event.at } : link))
    }
  }

  /** The app's activity changed: each kind reads again what a view shows of it, and nothing else. */
  applyActivity(serverId: string, { appId, kinds }: AppActivityEvent): void {
    for (const kind of new Set(kinds)) {
      switch (kind) {
        case 'calls':
          this.calls.reloadIfWatched(serverId, appId)
          this.callStats.reloadIfWatched(serverId, appId)
          this.scheduleCalls.reloadIfWatched(serverId, appId)
          this.scheduleCalendar.reloadIfWatched(serverId, appId)
          this.failedCalls.reloadIfWatched(serverId, appId)
          this.callDetail.reloadIfWatched(serverId, appId)
          this.runCalls.reloadIfWatched(serverId, appId)
          this.metrics.reloadIfWatched(serverId, appId)
          break
        case 'runs':
          this.runs.reloadIfWatched(serverId, appId)
          this.runDetail.reloadIfWatched(serverId, appId)
          break
        case 'signals':
          this.signals.reloadIfWatched(serverId, appId)
          break
        case 'files':
          this.files.reloadIfWatched(serverId, appId)
          break
        case 'models':
          this.modelCallDetail.reloadIfWatched(serverId, appId)
          break
        case 'deployment':
          this.deployment.reloadIfWatched(serverId, appId)
          this.deploymentLog.reloadIfWatched(serverId, appId)
          break
      }
    }
  }

  // ─── Commands ───

  /** Runs one call of the app's UI. Answers the host's `{ "value": ... }` as JSON text. */
  call(serverId: string, appId: string, name: string, argumentsJson: string): Promise<string> {
    return serverConnections.apiFor(serverId).appCall({ appId, name, argumentsJson })
  }

  /**
   * The newest call of an operation from a UI since a time, with its trace:
   * what the Operations console ran. Null when the log has none.
   */
  async latestUiCall(serverId: string, appId: string, operation: string, since: number): Promise<AppCallDetail | null> {
    const api = serverConnections.apiFor(serverId)
    const [call] = await api.appCalls({ appId, operation, callerKind: 'ui', since, limit: 1 })
    return call ? api.appCallRead({ appId, callId: call.id }) : null
  }

  async stop(serverId: string, appId: string): Promise<void> {
    this.acceptState(serverId, await serverConnections.apiFor(serverId).appStop({ appId }))
  }

  async start(serverId: string, appId: string): Promise<void> {
    this.acceptState(serverId, await serverConnections.apiFor(serverId).appStart({ appId }))
  }

  /** Deletes the app with its data, repository, schedules, secrets, and webhooks. */
  async remove(serverId: string, appId: string): Promise<void> {
    if (!(await serverConnections.apiFor(serverId).appDelete({ appId }))) return
    const key = appKey(serverId, appId)
    this.changedAt.set(key, ++this.changeCount)
    this.dropApp(key)
  }

  /** Makes an earlier version active. App data is not rewound. */
  async activate(serverId: string, appId: string, version: number): Promise<void> {
    this.acceptState(serverId, await serverConnections.apiFor(serverId).appActivate({ appId, version }))
    void this.versions.load(serverId, appId)
  }

  /**
   * Builds one revision on the host and makes the version active; the newest
   * revision when `commit` is absent. The host answers only when the build
   * ended: `apps.changed` shows the version while it builds.
   */
  async deploy(serverId: string, appId: string, commit?: string): Promise<AppDeployReceipt> {
    const receipt = await serverConnections.apiFor(serverId).appDeploy(commit ? { appId, commit } : { appId })
    this.put(serverId, receipt.app)
    if (this.states.has(appKey(serverId, appId))) void this.loadState(serverId, appId)
    this.versions.reloadIfLoaded(serverId, appId)
    this.revisions.reloadIfLoaded(serverId, appId)
    return receipt
  }

  /** Renames the app, describes it, or colours its tile. A field left out stays; null goes back to the manifest's text or the colour from the id. */
  async update(serverId: string, appId: string, patch: AppUpdate): Promise<void> {
    this.acceptState(serverId, await serverConnections.apiFor(serverId).appUpdate({ appId, patch }))
  }

  /** Turns the app's operations on or off as tools for agents. */
  async setAgentAccess(serverId: string, appId: string, enabled: boolean): Promise<void> {
    this.acceptState(serverId, await serverConnections.apiFor(serverId).appSetAgentAccess({ appId, enabled }))
  }

  async setScheduleEnabled(serverId: string, appId: string, name: string, enabled: boolean): Promise<void> {
    this.schedules.accept(serverId, appId, await serverConnections.apiFor(serverId).appScheduleSet({ appId, name, enabled }))
    // A paused schedule has no run to come.
    this.scheduleCalendar.reloadIfLoaded(serverId, appId)
  }

  async runSchedule(serverId: string, appId: string, name: string): Promise<void> {
    this.schedules.accept(serverId, appId, await serverConnections.apiFor(serverId).appScheduleRun({ appId, name }))
  }

  /** Gives a secret its value; null clears it. The value is never read back. */
  async setSecret(serverId: string, appId: string, name: string, value: string | null): Promise<void> {
    this.acceptState(serverId, await serverConnections.apiFor(serverId).appSecretSet({ appId, name, value }))
    // The preflight names the secrets with no value.
    this.deployPreflight.reloadIfLoaded(serverId, appId)
  }

  /** Sets one config value; null gives the field its default again. */
  async setConfig(serverId: string, appId: string, name: string, value: AppConfigValue | null): Promise<void> {
    this.acceptState(serverId, await serverConnections.apiFor(serverId).appConfigSet({ appId, name, value }))
  }

  /** Stops a run that is running or sleeping. */
  async terminateRun(serverId: string, appId: string, runId: string): Promise<void> {
    this.acceptRun(serverId, appId, await serverConnections.apiFor(serverId).appRunTerminate({ appId, runId }))
  }

  /** Starts a failed run again: the failed step runs again, and the finished steps do not. */
  async retryRun(serverId: string, appId: string, runId: string): Promise<void> {
    this.acceptRun(serverId, appId, await serverConnections.apiFor(serverId).appRunRetry({ appId, runId }))
  }

  /** Takes a failed run off what needs the owner, with no retry. The run stays in the history. */
  async dismissRun(serverId: string, appId: string, runId: string): Promise<void> {
    this.acceptRun(serverId, appId, await serverConnections.apiFor(serverId).appRunDismiss({ appId, runId }))
  }

  /** Makes a signal action, or changes the one `actionId` names. */
  async saveSignalAction(serverId: string, appId: string, signal: string, action: AppSignalAction, enabled: boolean, actionId?: string): Promise<void> {
    const request: AppSignalActionSaveRequest = { appId, signal, action, enabled }
    if (actionId) request.actionId = actionId
    this.signals.accept(serverId, appId, await serverConnections.apiFor(serverId).appSignalActionSave(request))
  }

  async deleteSignalAction(serverId: string, appId: string, actionId: string): Promise<void> {
    this.signals.accept(serverId, appId, await serverConnections.apiFor(serverId).appSignalActionDelete({ appId, actionId }))
  }

  /** A new signing secret for one webhook the app declares. */
  async rotateWebhookSecret(serverId: string, appId: string, name: string): Promise<void> {
    this.webhooks.accept(serverId, appId, await serverConnections.apiFor(serverId).appWebhookRotateSecret({ appId, name }))
  }

  /** Sends the active version to the app's deployment, and makes the deployment first when the app has none. A version that did not start there is in the receipt. */
  async publish(serverId: string, request: AppPublishRequest): Promise<AppPublishReceipt> {
    const receipt = await serverConnections.apiFor(serverId).appPublish(request)
    this.deployment.accept(serverId, request.appId, receipt.deployment)
    return receipt
  }

  /** What a host has for a publish; undefined until it answers, and for a host that cannot say. */
  publishPlacesFor(serverId: string): AppPublishPlaces | undefined {
    return this.publishPlaces.get(serverId)
  }

  /** Reads what a host has for a publish. A host that cannot say keeps what the client had. */
  async loadPublishPlaces(serverId: string): Promise<void> {
    const places = await serverConnections.apiFor(serverId).appPublishPlaces().catch(() => null)
    if (places) this.publishPlaces.set(serverId, places)
  }

  /** Sets the Tailscale auth key of a host, or removes it with null. The value is never read back. */
  async setTailscaleKey(serverId: string, value: string | null): Promise<void> {
    this.publishPlaces.set(serverId, await serverConnections.apiFor(serverId).appTailscaleKeySet({ value }))
  }

  /** Removes the app's deployment with the data it holds. */
  async unpublish(serverId: string, appId: string): Promise<void> {
    await serverConnections.apiFor(serverId).appUnpublish({ appId })
    this.deployment.accept(serverId, appId, null)
  }

  /** Stops a queued or running model call. */
  async cancelModelCall(serverId: string, appId: string, callId: string): Promise<void> {
    const call = await serverConnections.apiFor(serverId).appModelCallCancel({ appId, callId })
    if (this.modelCallDetail.queryFor(serverId, appId) === call.id) this.modelCallDetail.accept(serverId, appId, call)
  }

  /** Links a session of the app's host to the app: a session the owner started for it. */
  async linkSession(serverId: string, appId: string, sessionId: string): Promise<void> {
    this.sessions.accept(serverId, appId, await serverConnections.apiFor(serverId).appSessionLink({ appId, sessionId }))
  }

  /** Takes one session off the app's linked sessions. The session stays. */
  async unlinkSession(serverId: string, appId: string, sessionId: string): Promise<void> {
    this.sessions.accept(serverId, appId, await serverConnections.apiFor(serverId).appSessionUnlink({ appId, sessionId }))
  }

  /** Deletes one app file. */
  async removeFile(serverId: string, appId: string, fileId: string): Promise<void> {
    this.files.accept(serverId, appId, await serverConnections.apiFor(serverId).appFileRemove({ appId, fileId }))
  }

  // ─── Internals ───

  /** A command answered with the run: it is newer than a read in flight, when a view shows that run. */
  private acceptRun(serverId: string, appId: string, run: AppRunDetail): void {
    if (this.runDetail.queryFor(serverId, appId) === run.id) this.runDetail.accept(serverId, appId, run)
    void this.runs.load(serverId, appId)
  }

  private put(serverId: string, app: AppSummary): void {
    const key = appKey(serverId, app.id)
    this.changedAt.set(key, ++this.changeCount)
    this.entries.set(key, { serverId, app })
  }

  private putState(serverId: string, state: AppState): void {
    const key = appKey(serverId, state.app.id)
    this.put(serverId, state.app)
    this.states.set(key, state)
    this.stateErrors.delete(key)
  }

  /** A command answered with the state: it is newer than any read in flight. */
  private acceptState(serverId: string, state: AppState): void {
    const key = appKey(serverId, state.app.id)
    this.stateReads.set(key, (this.stateReads.get(key) ?? 0) + 1)
    this.statesInFlight.delete(key)
    this.putState(serverId, state)
  }

  /** A host that went away: its rows are no longer current, so they go. */
  private forgetHost(serverId: string): void {
    this.hostStatus.delete(serverId)
    this.publishPlaces.delete(serverId)
    for (const [key, row] of this.entries) if (row.serverId === serverId) this.dropApp(key)
  }

  private dropApp(key: string): void {
    this.entries.delete(key)
    this.states.delete(key)
    this.stateErrors.delete(key)
    this.stateReads.set(key, (this.stateReads.get(key) ?? 0) + 1)
    this.statesInFlight.delete(key)
    this.uis.delete(key)
    this.uiErrors.delete(key)
    this.uiReads.set(key, (this.uiReads.get(key) ?? 0) + 1)
    this.uisInFlight.delete(key)
    this.dataVersions.delete(key)
    for (const resource of this.resources) resource.drop(key)
  }
}

export const appsStore = new AppsStore()
