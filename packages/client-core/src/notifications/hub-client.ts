import {
  NOTIFICATION_HUB_VERSION,
  NOTIFICATION_PAGE_DEFAULT,
  type NotificationCount,
  type NotificationFilter,
  type NotificationHubCapability,
  type NotificationListRequest,
  type NotificationPage,
  type NotificationSetArchived,
  type NotificationSetRead,
  type NotificationStateResult,
} from '@solus/contracts/notification-hub'
import { rpcErrorCode } from '../rpc-error'
import { compareHubRows, hubRowKey, matchesHubFilter, mergedHorizon, type HubRow } from './merge'

/**
 * The client side of the notifications hub (plans/015-notifications-hub.md §6).
 *
 * One engine per signed-in identity. Each source is read on its own: its count,
 * plus history only while a page shows it. Reads follow changes, reconnects,
 * the app returns to the foreground, or a person asks. A burst of signals while a
 * read runs costs one more read. One source failing or being slow never holds
 * the others. A read or archive choice goes to the row's own source while that
 * source is connected, is awaited, and is followed by a fresh read; nothing is
 * queued, saved, or sent again on its own.
 *
 * The engine writes the maps it is given entry by entry, so a reactive map
 * (`SvelteMap`) invalidates only what changed.
 */

/**
 * One place the hub reads from. A source is named by its verified identity,
 * never by a route: two routes to one host are one source.
 */
export interface NotificationSource {
  /** Stable across routes and reloads: the host's id, or the organization service's id. */
  sourceId: string
  /** The connection the source is read through. */
  serverId: string
  kind: 'host' | 'organization'
  label: string
  /** The organization of an organization home. */
  organizationId?: string
}

/** The hub calls of one source, as a host or an organization service answers them. */
export interface NotificationSourceApi {
  notificationsCapability(): Promise<NotificationHubCapability>
  notificationsList(request: NotificationListRequest): Promise<NotificationPage>
  notificationsCount(): Promise<NotificationCount>
  notificationsSetRead(request: NotificationSetRead): Promise<NotificationStateResult>
  notificationsSetArchived(request: NotificationSetArchived): Promise<NotificationStateResult>
}

/** How the engine holds one source: its calls, its change signal, and the connection it borrowed. */
export interface NotificationSourceLink {
  api: NotificationSourceApi
  /** `notifications.changed` from this source. */
  onChanged(listener: () => void): () => void
  /** The source connected. Its first acceptance can share the queued initial read. */
  onReconnected(listener: (initialConnection?: boolean) => void): () => void
  /** Give back the connection the link holds. */
  release(): void
}

/** `offline`: the last read failed; rows already loaded stay, marked stale, and choices are disabled. */
export type HubSourceStatus = 'loading' | 'ready' | 'offline' | 'unsupported'

export interface HubSourceState {
  source: NotificationSource
  status: HubSourceStatus
  error?: string
  count: NotificationCount | null
  /** The source has rows older than the ones loaded. */
  hasMore: boolean
  oldestLoadedAt: number | null
}

/** The unread count across sources, and whether every source answered it. */
export interface HubUnreadCount {
  unread: number
  isCapped: boolean
  isComplete: boolean
}

export interface NotificationHubClientOptions {
  identity: string
  connect(source: NotificationSource): NotificationSourceLink
  rows?: Map<string, HubRow>
  sources?: Map<string, HubSourceState>
  /** Row keys whose choice is waiting for its source's answer. */
  pending?: Set<string>
  /** Sources read at once. */
  concurrency?: number
  pageSize?: number
}

interface SourceRuntime {
  source: NotificationSource
  link: NotificationSourceLink
  /** Bumped by every new read and by removal: an answer of an older one is dropped. */
  generation: number
  cursor: string | null
  reading: Promise<void> | null
  readAgain: boolean
  capability: NotificationHubCapability | null
  unsubscribes: (() => void)[]
}

export class NotificationHubClient {
  readonly rows: Map<string, HubRow>
  readonly sources: Map<string, HubSourceState>
  readonly pending: Set<string>
  private readonly runtimes = new Map<string, SourceRuntime>()
  private readonly waiting: (() => Promise<void>)[] = []
  private readonly inFlight = new Set<Promise<unknown>>()
  private active = 0
  private isStopped = false
  private filter: NotificationFilter = { view: 'all' }
  private historyVisible = false

  constructor(private readonly options: NotificationHubClientOptions) {
    this.rows = options.rows ?? new Map()
    this.sources = options.sources ?? new Map()
    this.pending = options.pending ?? new Set()
  }

  get identity(): string {
    return this.options.identity
  }

  /** Read these sources. A source no longer listed is forgotten, rows and all. */
  setSources(next: readonly NotificationSource[]): void {
    if (this.isStopped) return
    const nextIds = new Set(next.map((source) => source.sourceId))
    for (const sourceId of [...this.runtimes.keys()]) {
      if (!nextIds.has(sourceId)) this.removeSource(sourceId)
    }
    for (const source of next) if (!this.runtimes.has(source.sourceId)) this.addSource(source)
  }

  /** Page lifetime, independent of badges: opening reads history; closing stops
   * history reads while count subscriptions continue. */
  setHistoryVisible(visible: boolean): void {
    if (this.historyVisible === visible) return
    this.historyVisible = visible
    for (const runtime of this.runtimes.values()) {
      if (visible) {
        this.setStatus(runtime.source.sourceId, 'loading')
        void this.refresh(runtime.source.sourceId)
      } else {
        runtime.generation++
        this.dropSourceRows(runtime.source.sourceId)
        runtime.cursor = null
        this.patchSource(runtime.source.sourceId, { hasMore: false, oldestLoadedAt: null })
        if (runtime.reading) void this.refresh(runtime.source.sourceId)
      }
    }
  }

  /** A filter change reads history only while a page shows it. */
  setFilter(filter: NotificationFilter): void {
    if (this.filter.view === filter.view
      && JSON.stringify([...(this.filter.kinds ?? [])].sort()) === JSON.stringify([...(filter.kinds ?? [])].sort())) return
    this.filter = filter
    if (!this.historyVisible) return
    for (const runtime of this.runtimes.values()) {
      runtime.generation++
      this.setStatus(runtime.source.sourceId, 'loading')
      void this.refresh(runtime.source.sourceId)
    }
  }

  /** Read one source's first page again; with no id, every source's. */
  refresh(sourceId?: string): Promise<void> {
    if (sourceId === undefined) return Promise.all([...this.runtimes.keys()].map((id) => this.refresh(id))).then(() => {})
    const runtime = this.runtimes.get(sourceId)
    if (!runtime) return Promise.resolve()
    if (runtime.reading) {
      runtime.readAgain = true
      return runtime.reading
    }
    const read = new Promise<void>((resolve) => this.schedule(() => this.readFirstPage(runtime).finally(resolve)))
    runtime.reading = this.track(read).finally(() => {
      runtime.reading = null
      if (runtime.readAgain && this.runtimes.get(sourceId) === runtime) {
        runtime.readAgain = false
        void this.refresh(sourceId)
      }
    })
    return runtime.reading
  }

  /** The next page of every source that still has older rows. */
  async loadMore(): Promise<void> {
    if (!this.historyVisible) return
    await this.track(Promise.all([...this.runtimes.values()].map(async (runtime) => {
      const state = this.sources.get(runtime.source.sourceId)
      if (state?.status !== 'ready' || !state.hasMore || !runtime.cursor || runtime.reading) return
      const generation = runtime.generation
      try {
        const page = await runtime.link.api.notificationsList({ filter: this.filter, limit: this.pageSize(), cursor: runtime.cursor })
        if (!this.historyVisible || !this.isCurrent(runtime, generation)) return
        this.takePage(runtime, page)
      } catch (error) {
        if (this.isCurrent(runtime, generation)) this.setStatus(runtime.source.sourceId, 'offline', error instanceof Error ? error.message : String(error))
      }
    })))
  }

  /** Whether a choice about this row can be sent now: its source answered its last read. */
  canChange(rowKey: string): boolean {
    const row = this.rows.get(rowKey)
    return !!row && this.sources.get(row.sourceId)?.status === 'ready' && !this.pending.has(rowKey)
  }

  setRead(rowKey: string, read: boolean): Promise<boolean> {
    return this.change(rowKey, (api, id) => api.notificationsSetRead({ id, read }))
  }

  setArchived(rowKey: string, archived: boolean): Promise<boolean> {
    return this.change(rowKey, (api, id) => api.notificationsSetArchived({ id, archived }))
  }

  /**
   * The loaded rows, newest first, cut at the horizon below which a source with
   * more pages has not reported yet, so no row is skipped between sources.
   */
  entries(sourceIds?: ReadonlySet<string>): HubRow[] {
    const horizon = mergedHorizon(this.sources.values())
    const visible: HubRow[] = []
    for (const row of this.rows.values()) {
      if (row.notification.createdAt < horizon) continue
      if (sourceIds && !sourceIds.has(row.sourceId)) continue
      visible.push(row)
    }
    return visible.sort(compareHubRows)
  }

  unreadCount(): HubUnreadCount {
    let unread = 0
    let isCapped = false
    let isComplete = true
    for (const state of this.sources.values()) {
      if (state.status === 'unsupported') continue
      if (state.status !== 'ready' || !state.count) isComplete = false
      if (!state.count) continue
      unread += state.count.unread
      isCapped ||= state.count.isCapped
    }
    return { unread, isCapped, isComplete }
  }

  /** Resolves once no read or write this engine started is still running. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0 || this.waiting.length > 0) await Promise.allSettled([...this.inFlight])
  }

  /** Stop reading and give back every connection. */
  stop(): void {
    this.isStopped = true
    for (const sourceId of [...this.runtimes.keys()]) this.detach(sourceId)
  }

  /** The person signed out, or another signed in: nothing of theirs stays. */
  signOut(): void {
    this.stop()
    this.rows.clear()
    this.sources.clear()
    this.pending.clear()
  }

  // ─── Sources ───

  private addSource(source: NotificationSource): void {
    this.sources.set(source.sourceId, { source, status: 'loading', count: null, hasMore: false, oldestLoadedAt: null })
    const runtime: SourceRuntime = {
      source, link: this.options.connect(source), generation: 0, cursor: null, reading: null, readAgain: false, capability: null, unsubscribes: [],
    }
    this.runtimes.set(source.sourceId, runtime)
    // Subscribed before the first read: a change during it asks for one more.
    runtime.unsubscribes.push(runtime.link.onChanged(() => { void this.refresh(source.sourceId) }))
    runtime.unsubscribes.push(runtime.link.onReconnected((initialConnection) => {
      if (initialConnection && (runtime.reading || runtime.capability)) return
      runtime.capability = null
      runtime.generation++
      void this.refresh(source.sourceId)
    }))
    void this.refresh(source.sourceId)
  }

  private removeSource(sourceId: string): void {
    this.detach(sourceId)
    this.dropSourceRows(sourceId)
    this.sources.delete(sourceId)
  }

  private detach(sourceId: string): void {
    const runtime = this.runtimes.get(sourceId)
    if (!runtime) return
    runtime.generation++
    for (const unsubscribe of runtime.unsubscribes) unsubscribe()
    runtime.link.release()
    this.runtimes.delete(sourceId)
  }

  private dropSourceRows(sourceId: string): void {
    for (const [key, row] of [...this.rows]) {
      if (row.sourceId !== sourceId) continue
      this.rows.delete(key)
      this.pending.delete(key)
    }
  }

  private schedule(task: () => Promise<void>): void {
    const run = async () => {
      this.active++
      try {
        await task()
      } finally {
        this.active--
        const next = this.waiting.shift()
        if (next) void next()
      }
    }
    if (this.active < (this.options.concurrency ?? 3)) void run()
    else this.waiting.push(run)
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work)
    void work.finally(() => this.inFlight.delete(work)).catch(() => {})
    return work
  }

  private isCurrent(runtime: SourceRuntime, generation: number): boolean {
    return !this.isStopped && this.runtimes.get(runtime.source.sourceId) === runtime && runtime.generation === generation
  }

  /** Replace a source's state with a patched copy, so a reactive map sees the change. */
  private patchSource(sourceId: string, patch: Partial<HubSourceState>): void {
    const state = this.sources.get(sourceId)
    if (state) this.sources.set(sourceId, { ...state, ...patch })
  }

  private setStatus(sourceId: string, status: HubSourceStatus, error?: string): void {
    const state = this.sources.get(sourceId)
    if (!state) return
    const { error: _previous, ...rest } = state
    this.sources.set(sourceId, error ? { ...rest, status, error } : { ...rest, status })
  }

  private pageSize(): number {
    return this.options.pageSize ?? NOTIFICATION_PAGE_DEFAULT
  }

  // ─── Reads ───

  /**
   * A fresh first page replaces what this client held of the source; its older
   * pages are read again through `loadMore`, so a row archived or revoked since
   * never lingers in an old page.
   */
  private async readFirstPage(runtime: SourceRuntime): Promise<void> {
    const generation = ++runtime.generation
    const { sourceId } = runtime.source
    try {
      const capability = runtime.capability ?? await runtime.link.api.notificationsCapability()
      if (!this.isCurrent(runtime, generation)) return
      runtime.capability = capability
      if (capability.version < NOTIFICATION_HUB_VERSION) return this.unsupported(sourceId)
      const [page, count] = await Promise.all([
        this.historyVisible ? runtime.link.api.notificationsList({ filter: this.filter, limit: this.pageSize() }) : null,
        runtime.link.api.notificationsCount(),
      ])
      if (!this.isCurrent(runtime, generation)) return
      this.patchSource(sourceId, { count })
      if (page && this.historyVisible) {
        this.dropSourceRows(sourceId)
        this.patchSource(sourceId, { oldestLoadedAt: null })
        this.takePage(runtime, page)
      }
      this.setStatus(sourceId, 'ready')
    } catch (error) {
      if (!this.isCurrent(runtime, generation)) return
      if (error instanceof Error && isUnsupported(error)) return this.unsupported(sourceId)
      // A plain failure is stale state, not a revocation: the loaded rows stay.
      this.setStatus(sourceId, 'offline', error instanceof Error ? error.message : String(error))
    }
  }

  private takePage(runtime: SourceRuntime, page: NotificationPage): void {
    const { sourceId } = runtime.source
    for (const notification of page.items) this.rows.set(hubRowKey(sourceId, notification.id), { sourceId, notification })
    runtime.cursor = page.cursor
    const state = this.sources.get(sourceId)
    if (!state) return
    this.patchSource(sourceId, { hasMore: page.cursor !== null, oldestLoadedAt: page.items.at(-1)?.createdAt ?? state.oldestLoadedAt })
  }

  private unsupported(sourceId: string): void {
    this.dropSourceRows(sourceId)
    this.setStatus(sourceId, 'unsupported')
  }

  // ─── Choices ───

  /**
   * One read or archive choice, sent once to the row's own source. The answer
   * replaces the row; a failure is shown and the source is read again. Answers
   * whether the source applied it.
   */
  private async change(rowKey: string, send: (api: NotificationSourceApi, id: string) => Promise<NotificationStateResult>): Promise<boolean> {
    const row = this.rows.get(rowKey)
    const runtime = row ? this.runtimes.get(row.sourceId) : undefined
    if (!row || !runtime || !this.canChange(rowKey)) return false
    this.pending.add(rowKey)
    const { sourceId } = row
    try {
      const result = await this.track(send(runtime.link.api, row.notification.id))
      if (this.runtimes.get(sourceId) !== runtime) return false
      if (!result.ok) {
        this.rows.delete(rowKey)
        return false
      }
      if (matchesHubFilter(result.notification, this.filter)) this.rows.set(rowKey, { sourceId, notification: result.notification })
      else this.rows.delete(rowKey)
      return true
    } catch (error) {
      // Not sent again: an unanswered choice may or may not have applied. The read below shows which.
      this.setStatus(sourceId, 'offline', error instanceof Error ? error.message : String(error))
      return false
    } finally {
      this.pending.delete(rowKey)
      void this.refresh(sourceId)
    }
  }
}

/** A source that does not offer the hub: an older host, or one that serves no collaboration plane. */
function isUnsupported(error: Error): boolean {
  return error.message.startsWith('Unknown method') || rpcErrorCode(error) === 'PLANE_DISABLED'
}
