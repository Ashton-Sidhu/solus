import { SvelteMap } from 'svelte/reactivity'
import type {
  AppCallView,
  AppScheduleView,
  AppSessionLink,
  AppState,
  AppSummary,
  AppUi,
  AppVersionDiff,
  AppVersionView,
  AppWebhookView,
  AppsChangedEvent,
} from '@solus/contracts/apps'
import { isSolusApiId } from '@solus/contracts/uplink'
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'

/**
 * Every app this client can see (docs/plans/apps.md §9), read from each
 * connected host and joined into one list. Each row names its host. A host
 * that is not ready has no rows here: the list never shows old rows as
 * current. `apps.changed` keeps the rows fresh, `apps.dataChanged` raises the
 * app's data version, and a reconnect reads the host again.
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

/** The call log a menu reads at one time. */
const CALL_PAGE = 200

function appKey(serverId: string, appId: string): string {
  return `${serverId}\n${appId}`
}

/**
 * One list of an app's menu (versions, schedules, webhooks, calls, sessions),
 * for each app that a view loaded it for. A read that a newer read or a
 * command's answer overtook is dropped.
 */
class AppMenuList<Entry> {
  private readonly lists = new SvelteMap<string, Entry[]>()
  private readonly errors = new SvelteMap<string, string>()
  private readonly reads = new Map<string, number>()

  constructor(private readonly read: (api: HostApi, appId: string) => Promise<Entry[]>) {}

  get(serverId: string, appId: string): Entry[] | undefined {
    return this.lists.get(appKey(serverId, appId))
  }

  errorFor(serverId: string, appId: string): string | null {
    return this.errors.get(appKey(serverId, appId)) ?? null
  }

  async load(serverId: string, appId: string): Promise<void> {
    const key = appKey(serverId, appId)
    const read = (this.reads.get(key) ?? 0) + 1
    this.reads.set(key, read)
    try {
      const list = await this.read(serverConnections.apiFor(serverId), appId)
      if (this.reads.get(key) !== read) return
      this.lists.set(key, list)
      this.errors.delete(key)
    } catch (error) {
      if (this.reads.get(key) !== read) return
      this.errors.set(key, error instanceof Error && error.message ? error.message : 'The host did not answer.')
    }
  }

  /** A command answered with the whole list: it is newer than any read in flight. */
  accept(serverId: string, appId: string, list: Entry[]): void {
    const key = appKey(serverId, appId)
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1)
    this.lists.set(key, list)
    this.errors.delete(key)
  }

  /** Read again, when a view loaded the list before. */
  reloadIfLoaded(serverId: string, appId: string): void {
    if (this.lists.has(appKey(serverId, appId))) void this.load(serverId, appId)
  }

  drop(key: string): void {
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1)
    this.lists.delete(key)
    this.errors.delete(key)
  }
}

export class AppsStore {
  /** Keyed by host and app id: two hosts can hold the same id. */
  private readonly entries = new SvelteMap<string, AppRow>()
  private readonly hostStatus = new SvelteMap<string, AppHostStatus>()
  private readonly states = new SvelteMap<string, AppState>()
  private readonly stateErrors = new SvelteMap<string, string>()
  private readonly uis = new SvelteMap<string, AppUiRead>()
  private readonly uiErrors = new SvelteMap<string, string>()
  private readonly dataVersions = new SvelteMap<string, number>()
  private revision = 0
  private readonly revisions = new Map<string, number>()
  private readonly stateReads = new Map<string, number>()
  private readonly statesInFlight = new Set<string>()
  private readonly uiReads = new Map<string, number>()
  /** The version each UI read in flight asked for. */
  private readonly uisInFlight = new Map<string, number>()
  private readonly deployListeners = new Set<(deploy: AppDeploy) => void>()
  private watchCount = 0
  private stopWatching: (() => void) | null = null

  readonly versions = new AppMenuList<AppVersionView>((api, appId) => api.appVersions({ appId }))
  readonly schedules = new AppMenuList<AppScheduleView>((api, appId) => api.appSchedules({ appId }))
  readonly webhooks = new AppMenuList<AppWebhookView>((api, appId) => api.appWebhooks({ appId }))
  readonly calls = new AppMenuList<AppCallView>((api, appId) => api.appCalls({ appId, limit: CALL_PAGE }))
  readonly sessions = new AppMenuList<AppSessionLink>((api, appId) => api.appSessions({ appId }))

  /** Surfaces that show apps hold one shared watch over every host. */
  watch(): () => void {
    if (this.watchCount++ === 0) {
      const stopChanged = subscribeAllHosts('apps.changed', (serverId, event) => this.applyChange(serverId, event))
      const stopData = subscribeAllHosts('apps.dataChanged', (serverId, change) => this.applyDataChange(serverId, change.appId))
      const stopReadiness = serverConnections.onReadinessChange((serverId, status) => {
        if (isSolusApiId(serverId)) return
        if (status === 'ready') void this.load(serverId)
        else this.forgetHost(serverId)
      })
      this.stopWatching = () => { stopChanged(); stopData(); stopReadiness() }
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
    const startedRevision = this.revision
    if (!this.hostStatus.has(serverId)) this.hostStatus.set(serverId, 'loading')
    try {
      const list = await serverConnections.apiFor(serverId).appList()
      if (serverConnections.readinessFor(serverId).readiness !== 'ready') return
      const liveKeys = new Set<string>()
      for (const app of list) {
        const key = appKey(serverId, app.id)
        liveKeys.add(key)
        if ((this.revisions.get(key) ?? 0) > startedRevision) continue
        this.entries.set(key, { serverId, app })
      }
      for (const [key, row] of this.entries) {
        if (row.serverId !== serverId || liveKeys.has(key)) continue
        if ((this.revisions.get(key) ?? 0) > startedRevision) continue
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

  // ─── Events ───

  applyChange(serverId: string, event: AppsChangedEvent): void {
    if (event.kind === 'deleted') {
      const key = appKey(serverId, event.appId)
      this.revisions.set(key, ++this.revision)
      this.dropApp(key)
      return
    }
    const { app } = event
    this.put(serverId, app)
    // What a view loaded can be old now: the descriptor, the secrets, and the menu's lists.
    if (this.states.has(appKey(serverId, app.id))) void this.loadState(serverId, app.id)
    this.versions.reloadIfLoaded(serverId, app.id)
    this.schedules.reloadIfLoaded(serverId, app.id)
    this.webhooks.reloadIfLoaded(serverId, app.id)
    this.sessions.reloadIfLoaded(serverId, app.id)
    if (event.deployedBySessionId) {
      const deploy: AppDeploy = { serverId, sessionId: event.deployedBySessionId, app }
      for (const listener of this.deployListeners) listener(deploy)
    }
  }

  applyDataChange(serverId: string, appId: string): void {
    const key = appKey(serverId, appId)
    this.dataVersions.set(key, (this.dataVersions.get(key) ?? 0) + 1)
  }

  // ─── Commands ───

  /** Runs one call of the app's UI. Answers the host's `{ "value": ... }` as JSON text. */
  call(serverId: string, appId: string, name: string, argumentsJson: string): Promise<string> {
    return serverConnections.apiFor(serverId).appCall({ appId, name, argumentsJson })
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
    this.revisions.set(key, ++this.revision)
    this.dropApp(key)
  }

  /** Makes an earlier version active. App data is not rewound. */
  async activate(serverId: string, appId: string, version: number): Promise<void> {
    this.acceptState(serverId, await serverConnections.apiFor(serverId).appActivate({ appId, version }))
    void this.versions.load(serverId, appId)
  }

  async setScheduleEnabled(serverId: string, appId: string, name: string, enabled: boolean): Promise<void> {
    this.schedules.accept(serverId, appId, await serverConnections.apiFor(serverId).appScheduleSet({ appId, name, enabled }))
  }

  async runSchedule(serverId: string, appId: string, name: string): Promise<void> {
    this.schedules.accept(serverId, appId, await serverConnections.apiFor(serverId).appScheduleRun({ appId, name }))
  }

  /** Gives a secret its value; null clears it. The value is never read back. */
  async setSecret(serverId: string, appId: string, name: string, value: string | null): Promise<void> {
    this.acceptState(serverId, await serverConnections.apiFor(serverId).appSecretSet({ appId, name, value }))
  }

  // ─── Internals ───

  private put(serverId: string, app: AppSummary): void {
    const key = appKey(serverId, app.id)
    this.revisions.set(key, ++this.revision)
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
    this.versions.drop(key)
    this.schedules.drop(key)
    this.webhooks.drop(key)
    this.calls.drop(key)
    this.sessions.drop(key)
  }
}

export const appsStore = new AppsStore()
