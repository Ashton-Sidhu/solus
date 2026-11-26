import { remainingDirectoryRows, directoryOpeningRows } from './directory-opening'
import type { SessionDirectoryPage } from '@solus/contracts/host-api'
import type { MobileSessionCache } from './session-cache'
import { isLiveCodebase } from '@solus/client-core/codebases'
import { rpcErrorCode } from '@solus/client-core/rpc-error'
import { usesWindowFilter, visibleInWindow } from '@solus/client-core/organization-filter'
import { keepEqual, sameItems } from '@solus/client-core/keep-equal'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import { sessionExecutionStatus, type SessionExecution } from '@solus/contracts/session-execution'
import { sessionRecordStatusOf } from '@solus/contracts/types'
import type { PinnedSession, ProjectEntry, SessionRecord } from '@solus/contracts/types'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'
import type { HostRegistry } from '../hosts/host-registry'
import type { CloudSessions, CloudSessionRecord } from './cloud-sessions'
import type { SessionRunHosts } from './session-run-hosts'
import { ShareArrivals } from './shared-with-you'
import { markStart } from '../../lib/start-trace'

/**
 * Every session on every host this device knows, as one list: the Solus side
 * of T3 Code's thread shell (`EnvironmentThreadShell`), which T3's home list,
 * iPad sidebar, and thread screen read. A T3 "environment" is a Solus host; a
 * T3 "thread" is a Solus session. One host that cannot be read does not hide
 * the others.
 */

/** One session as the home list shows it. */
export interface SolusThreadShell {
  /** `hostId` and `sessionId`, joined: one session id on two hosts is two threads. */
  readonly key: string
  readonly hostId: string
  readonly hostLabel: string
  readonly record: SessionRecord
  /** Only the cloud lists the session: no host this phone reads has it yet
   *  (docs/plans/portable-sessions-cloud.md §5.5). Its thread opens with no
   *  conversation until a host has it. */
  readonly cloudOnly?: true
}

/** One project, for T3's project filter and the new-task project picker. */
export interface SolusProjectShell {
  readonly key: string
  readonly hostId: string
  readonly hostLabel: string
  readonly project: ProjectEntry
}

export type HostThreadsState =
  | { kind: 'idle' }
  | { kind: 'loading'; previous: HostThreads | null }
  | { kind: 'loaded'; value: HostThreads }
  | { kind: 'error'; message: string; previous: HostThreads | null }

export interface SessionRowChange {
  title?: string | null
  execution?: SessionExecution
}

export interface HostThreads {
  readonly opening?: Pick<SessionDirectoryPage, 'pins' | 'codebases' | 'automations'>
  readonly revision?: string
  readonly threads: readonly SolusThreadShell[]
  /** The most recently active sessions out of this person's list (archived,
   *  or idle): search finds them and a thread screen opens one, but the list
   *  does not show them. */
  readonly unlisted?: readonly SolusThreadShell[]
  readonly projects: readonly SolusProjectShell[]
  /** The host's first index sweep is still running: the list is not final. */
  readonly indexing: boolean
}

/** Every readable host's threads and projects, as one sorted snapshot. */
interface MergedThreads {
  readonly threads: readonly SolusThreadShell[]
  readonly unlisted: readonly SolusThreadShell[]
  readonly projects: readonly SolusProjectShell[]
}

export function threadKey(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`
}

export function projectRows(hostId: string, hostLabel: string, projects: ProjectEntry[], previous?: readonly SolusProjectShell[]) {
  const held = new Map(previous?.map(row => [row.project.path, row]))
  const rows = projects.map(project => {
    const row = { key: threadKey(hostId, project.path), hostId, hostLabel, project }
    const prior = held.get(project.path)
    return prior ? keepEqual(row, prior) : row
  })
  return previous && sameItems(previous, rows) ? previous : rows
}

/** How many sessions out of the list a host is asked for. The list itself
 *  has no limit: the host bounds it to this person's recent and waiting
 *  sessions (docs/plans/session-archive.md). */
const UNLISTED_LIMIT = 200

/** A host that is over its request budget keeps the list it showed; it is read again
 *  after the wait the host asks for, this many times before the error shows. */
const RATE_LIMIT_RETRIES = 3

const IDLE = { kind: 'idle' } as const

/** A host of the last start, as this device saved it: the start shows its saved list before the registry reads its hosts. */
export interface PresumedHost {
  readonly id: string
  readonly installationId: string
  readonly identityKey?: string
}

/**
 * The session shell of the hosts that have the `sessionShell` capability
 * (`SessionShells`, docs/plans/mobile-session-shell.md §6). For such a host the
 * shell gives the rows, and the directory reads below do not run.
 */
export interface ThreadDirectoryShell {
  /** The saved shell of the host as directory rows, or null when the device keeps none in this scope. */
  restore(hostId: string): Promise<HostThreads | null>
  /** True while the shell follows the host. */
  follows(hostId: string): boolean
  /** Opens the host's shell again when it is not live. */
  reload(hostId: string): void
}

/** How a cloud-only row names where it comes from when this phone keeps no host that ran it. */
const CLOUD_LABEL = 'Solus Cloud'

export class ThreadDirectory {
  readonly changes = new Listeners()
  private readonly hosts = new Map<string, HostThreadsState>()
  private readonly openingByHost = new Map<string, {
    codebases: Map<string, NonNullable<SessionDirectoryPage['codebases']>[number]>
    automations: Map<string, string>
  }>()

  openingCodebase(hostId: string, codebaseId: string) {
    const copy = this.openingByHost.get(hostId)?.codebases.get(codebaseId)
    return copy && isLiveCodebase(copy) ? copy : undefined
  }

  openingAutomation(hostId: string, automationId: string) {
    return this.openingByHost.get(hostId)?.automations.get(automationId)
  }

  private readonly restores = new Map<string, Promise<void>>()
  /** The hosts restored before the registry knew them: each stays until the registry confirms or leaves it out. */
  private readonly presumed = new Map<string, PresumedHost>()
  private readonly requests = new Map<string, number>()
  private readonly directoryWrites = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  /** The pins of each host's last whole read; a sessions-only read keeps them. */
  private readonly pins = new Map<string, readonly PinnedSession[]>()
  private readonly positions = new Map<string, Map<string, number>>()
  private lastReplacement?: { previous: readonly SolusThreadShell[]; positions: number[] }
  private visiblePositions = new Map<string, number>()
  private nextRequest = 0
  private organizationId: string | null = null
  /** A stable snapshot, replaced only when a host's state changes. */
  private merged: MergedThreads = { threads: [], unlisted: [], projects: [] }
  /** Sessions another session started, read for their parent's agent cards
   *  (`loadChildren`); the list answers only top-level sessions. */
  private children = new Map<string, SolusThreadShell>()
  private openedSearchResults = new Map<string, SolusThreadShell>()
  private readonly shareArrivals = new ShareArrivals()
  private readonly shareListeners = new Set<(threads: readonly SolusThreadShell[]) => void>()
  /** The cloud-only rows shown now, by thread key. */
  private cloudShells = new Map<string, SolusThreadShell>()
  /** The row of each cloud record, kept while its host and label do not change. */
  private readonly denied = new Set<string>()
  private readonly cloudShellOf = new WeakMap<CloudSessionRecord, SolusThreadShell>()

  constructor(
    private readonly registry: HostRegistry,
    private readonly connectionFor: (hostId: string) => HostConnection | null,
    /** What each host holds of a session: with it, a session two hosts list shows once. */
    private readonly runHosts?: Pick<SessionRunHosts, 'turnsFor' | 'readOnce' | 'changes'>,
    /** The sessions only the cloud lists: each gets one row. */
    private readonly cloud?: Pick<CloudSessions, 'onlyInCloud' | 'changes'>,
    /** One read of a host's pins, shared with the thread list (`ThreadListState.loadPins`). */
    private readonly readPins: (hostId: string, connection: HostConnection) => Promise<readonly PinnedSession[]> = (_hostId, connection) => connection.api.pinnedSessionsList(),
    private readonly cache?: MobileSessionCache,
    /**
     * True for a folder that is the container root of a codebase. Such a
     * folder is a codebase, never a project, so `projects()` leaves it out
     * (docs/plans/codebases.md decision 14). Each project list of the app
     * reads `projects()`, so they agree.
     */
    private readonly isContainerRoot: (hostId: string, path: string) => boolean = () => false,
    private readonly restorePins?: (hostId: string, pins: readonly PinnedSession[]) => void,
    private readonly shell?: ThreadDirectoryShell,
  ) {
    runHosts?.changes.subscribe(() => this.remerge())
    cloud?.changes.subscribe(() => this.remerge())
  }

  /** Shows the saved list of a host. `presumed` is the host of the last start, for a restore before the registry is read. */
  restore(hostId: string, presumed?: PresumedHost): Promise<void> {
    const held = this.restores.get(hostId)
    if (held) return held
    const host = this.registry.host(hostId) ?? presumed
    const cache = this.cache
    if (!host || (!cache && !this.shell)) return Promise.resolve()
    if (host === presumed) this.presumed.set(hostId, presumed)
    // The saved shell of a host that has one comes first; the directory copy is the older path.
    const savedShell = this.shell ? this.shell.restore(hostId).catch(() => null) : Promise.resolve(null)
    const pending = savedShell.then(shell => {
      markStart(`shell_read:${shell ? 'found' : 'none'}`)
      return shell ?? cache?.forHost(hostId).directory().then(directory => {
        markStart(`directory_read:${directory ? directory.threads.length : 'none'}`)
        return directory
      }) ?? null
    }).then(cached => {
      // The catalog rebuilds its host objects when a route or label changes. Forgetting
      // the host or switching accounts cancels this read even if the same id returns.
      const currentHost = this.registry.host(hostId) ?? this.presumed.get(hostId)
      if (!cached || this.restores.get(hostId) !== pending || this.denied.has(hostId) ||
          !currentHost || currentHost.installationId !== host.installationId ||
          (host.identityKey && currentHost.identityKey !== host.identityKey)) return
      const current = this.stateOf(hostId)
      if (current.kind === 'loaded' || (current.kind !== 'idle' && current.previous)) return
      if (cached.opening) this.restorePins?.(hostId, cached.opening.pins)
      this.set(hostId, current.kind === 'error' ? { ...current, previous: cached } : { kind: 'loading', previous: cached })
    }).finally(() => {
      if (this.restores.get(hostId) === pending) this.restores.delete(hostId)
    })
    this.restores.set(hostId, pending)
    return pending
  }

  /** True while the list of the host shows from the last start and the registry has not confirmed the host. */
  presumes(hostId: string): boolean {
    return this.presumed.has(hostId)
  }

  /**
   * The registry read its hosts: a presumed host that it knows as the same
   * installation stays. One it knows as another installation, or one that it
   * still leaves out after the host list and the directory answered, loses
   * the rows the start showed. Answers the hosts it dropped.
   */
  confirmPresumedHosts(): string[] {
    const listsAnswered = this.registry.listState() !== 'loading' && this.registry.directoryState() !== 'loading'
    const dropped: string[] = []
    for (const [hostId, presumed] of this.presumed) {
      const host = this.registry.host(hostId)
      if (host && host.installationId === presumed.installationId &&
          (!presumed.identityKey || !host.identityKey || host.identityKey === presumed.identityKey)) this.presumed.delete(hostId)
      else if (host || listsAnswered) {
        this.forgetHost(hostId)
        dropped.push(hostId)
      }
    }
    return dropped
  }

  /** Every host this directory holds a list or a pending restore for. */
  hostIds(): string[] {
    return [...new Set([...this.hosts.keys(), ...this.restores.keys()])]
  }

  /** Change the list filter without changing a record or closing an open thread. */
  /** The cloud machines of the organizations, whose threads the organization filter applies to. */
  cloudHostIds(): ReadonlySet<string> {
    return new Set(this.registry.hosts().filter((host) => host.uplink?.kind === 'cloud').map((host) => host.id))
  }

  selectOrganization(organizationId: string | null): void {
    if (this.organizationId === organizationId) return
    this.organizationId = organizationId
    this.remerge()
  }

  stateOf = (hostId: string): HostThreadsState => this.hosts.get(hostId) ?? IDLE

  /** Every readable host's sessions, newest activity first. Delegated child
   *  sessions open from their parent's transcript, not the list. */
  threads = (): readonly SolusThreadShell[] => this.merged.threads

  /** Every readable host's recent sessions out of the list, newest activity first. */
  changedPositions(previous: readonly SolusThreadShell[], previousFactsKeys: readonly string[]): number[] | undefined {
    if (previous !== this.merged.threads && previous !== this.lastReplacement?.previous) return undefined
    const positions = previous === this.merged.threads ? [] : [...this.lastReplacement!.positions]
    for (const key of previousFactsKeys) {
      const index = this.visiblePositions.get(key)
      if (index !== undefined) positions.push(index)
    }
    return positions
  }

  unlistedThreads = (): readonly SolusThreadShell[] => this.merged.unlisted

  /** Every readable host's projects, by folder name. A container root of a codebase is not one of them. */
  projects = (): readonly SolusProjectShell[] => this.merged.projects

  /** The codebases changed: a folder that is a container root now leaves the project list, and a folder that is one no longer comes back. */
  followContainerRoots(): void {
    const projects = this.listedProjects()
    if (sameItems(projects, this.merged.projects)) return
    this.merged = { ...this.merged, projects }
    this.changes.notify()
  }

  /** Hears the sessions a read finds newly shared with this person, newest
   *  grant first (docs/plans/shared-with-you.md §5). */
  subscribeShares(listener: (threads: readonly SolusThreadShell[]) => void): () => void {
    this.shareListeners.add(listener)
    return () => { this.shareListeners.delete(listener) }
  }

  /** A search can find a session beyond the directory's recent pages. */
  rememberSearchResult(thread: SolusThreadShell): void {
    if (this.openedSearchResults.size >= 100) this.openedSearchResults.delete(this.openedSearchResults.keys().next().value!)
    this.openedSearchResults.set(thread.key, thread)
    this.changes.notify()
  }

  /** A session in or out of the list, or a child session its parent's agent card opens. */
  thread = (hostId: string, sessionId: string): SolusThreadShell | null => {
    // An open thread stays readable when its organization leaves the list.
    const state = this.stateOf(hostId)
    const value = state.kind === 'loaded' ? state.value : state.kind === 'idle' ? null : state.previous
    const key = threadKey(hostId, sessionId)
    const position = this.positions.get(hostId)?.get(sessionId)
    return (position === undefined ? undefined : value?.threads[position])
      ?? value?.unlisted?.find((thread) => thread.key === key)
      ?? this.children.get(key)
      ?? this.openedSearchResults.get(key)
      ?? this.cloudShells.get(key)
      ?? null
  }

  /** True while any known host has not answered its first read. */
  isLoading = (): boolean =>
    this.registry.hosts().some((host) => {
      const state = this.stateOf(host.id)
      return state.kind === 'idle' || (state.kind === 'loading' && state.previous === null)
    })

  async loadAll(): Promise<void> {
    await Promise.all(this.registry.hosts().map((host) => this.load(host.id)))
  }

  /**
   * Read a host's sessions, projects, and pins. `sessions` reads only the
   * session records and keeps the projects and pins of the last whole read:
   * a session's status or title changes neither (`projects.changed` asks for
   * a whole read).
   */
  async load(hostId: string, attempt = 0, scope: 'all' | 'sessions' = 'all', opening?: Promise<SessionDirectoryPage | null>): Promise<void> {
    if (this.shell?.follows(hostId)) {
      // The host sends each change of the list; only a shell that is not live opens again.
      this.shell.reload(hostId)
      return
    }
    clearTimeout(this.retries.get(hostId))
    this.retries.delete(hostId)
    const host = this.registry.host(hostId)
    const connection = this.connectionFor(hostId)
    const current = this.stateOf(hostId)
    const previous = current.kind === 'loaded' ? current.value : current.kind === 'idle' ? null : current.previous
    if (!host || !connection) {
      this.set(hostId, { kind: 'error', message: 'This host cannot be reached now.', previous })
      return
    }
    const disk = this.cache?.forHost(hostId)
    const request = ++this.nextRequest
    const generation = connection.state.sessionGeneration
    this.requests.set(hostId, request)
    this.set(hostId, { kind: 'loading', previous })
    let next: HostThreadsState
    let retryAfterMs: number | null = null
    let denied = false
    let readPins: readonly PinnedSession[] | null = null
    const isCurrent = () => this.requests.get(hostId) === request
      && this.connectionFor(hostId) === connection
      && connection.state.sessionGeneration === generation
    try {
      const knownRevision = previous?.revision && (!previous.threads.length || previous.threads[0]?.hostLabel === host.label) ? previous.revision : undefined
      let rowSource = previous
      let positions = this.positions.get(hostId)
      const shell = (record: SessionRecord): SolusThreadShell => {
        const position = positions?.get(record.sessionId)
        const row = position === undefined ? undefined : rowSource?.threads[position]
        if (row?.hostLabel === host.label && keepEqual(record, row.record) === row.record) return row
        return { key: threadKey(hostId, record.sessionId), hostId, hostLabel: host.label, record }
      }
      const showFirstRows = (threads: readonly SolusThreadShell[], indexing: boolean) => {
        if (!threads.length || !isCurrent()) return
        const current = this.stateOf(hostId)
        if (current.kind !== 'loading' || current.previous?.threads.length) return
        rowSource = { opening: current.previous?.opening, threads, projects: current.previous?.projects ?? [], unlisted: current.previous?.unlisted ?? [], indexing }
        this.set(hostId, { kind: 'loading', previous: rowSource })
        positions = this.positions.get(hostId)
      }
      const page = opening ? await opening : null
      if (!isCurrent()) return
      let openingFacts = previous?.opening
      if (page) {
        markStart(`directory_answer:${page.records.length}`)
        openingFacts = { pins: page.pins, codebases: page.codebases, automations: page.automations }
        const present = directoryOpeningRows(page)
        const value: HostThreads = {
          opening: openingFacts, indexing: page.indexing, threads: present.map(shell),
          unlisted: page.pinnedRecords.filter(row => row.listed === false).map(shell),
          projects: projectRows(hostId, host.label, page.projects, previous?.projects),
        }
        // Keep a warm, longer list in place until its continuation has arrived.
        const showing = this.stateOf(hostId)
        if (!page.nextCursor || showing.kind !== 'loading' || !showing.previous?.threads.length) {
          this.set(hostId, { kind: 'loading', previous: value })
          this.scheduleDirectorySave(hostId)
          rowSource = value
          positions = this.positions.get(hostId)
        }
      }
      const listRead = page ? remainingDirectoryRows(connection.api, page) : connection.api.sessionRecordList(
        { includeWorktrees: true, ...(knownRevision && { knownRevision }) },
        previous?.threads.length ? undefined : page => showFirstRows(page.records.map(shell), page.indexing),
      )
      const details = Promise.all([
        connection.api.sessionRecordList({ includeWorktrees: true, scope: 'all', limit: UNLISTED_LIMIT }),
        page ? { projects: page.projects, pins: page.pins, readPins: page.pins } : this.readProjectsAndPins(hostId, connection, scope === 'sessions' && previous !== null),
      ])
      void details.catch(() => {}) // The list and its secondary reads can fail independently.
      const list = await listRead
      if (!isCurrent()) return
      const pendingState = this.stateOf(hostId)
      if (pendingState.kind === 'loading') {
        rowSource = pendingState.previous
        positions = this.positions.get(hostId)
      }
      const confirmed = list.unchanged && previous && knownRevision && list.revision === knownRevision
      const shells = confirmed ? previous.threads : list.records.map(shell)
      const indexing = confirmed ? previous.indexing : list.indexing
      // On a cold open the visible rows can paint while projects, archived rows and pins arrive.
      showFirstRows(shells, indexing)
      const [unlisted, listed] = await details
      const { projects, pins } = listed
      readPins = listed.readPins
      if (!page && openingFacts && readPins) openingFacts = { ...openingFacts, pins: [...readPins] }
      const knownSessions = new Set([...shells.map(thread => thread.record.sessionId), ...unlisted.records.map(record => record.sessionId)])
      // A pin must remain available even after its record leaves recent history.
      const missingPins = page ? page.pinnedRecords.filter(row => !knownSessions.has(row.sessionId)) : await Promise.all(pins.filter((pin) => !knownSessions.has(pin.sessionId))
        .map((pin) => connection.api.sessionRecordGet(pin.sessionId).catch(() => null)))
      const pinnedRecords = missingPins.filter((record): record is SessionRecord => record !== null)
      // An unchanged project keeps its object, so a reader of projects alone sees no change.
      const projectShells = projects === null ? previous?.projects ?? [] : projectRows(hostId, host.label, projects, rowSource?.projects)
      next = {
        kind: 'loaded',
        value: {
          opening: openingFacts,
          threads: shells,
          unlisted: [...unlisted.records.filter((record) => record.listed === false), ...pinnedRecords].map(shell),
          projects: projectShells,
          indexing,
          revision: list.revision,
        },
      }
    } catch (error) {
      denied = (error instanceof WorkspaceRequestError && (error.status === 403 || error.status === 401)) || (error instanceof Error && ['FORBIDDEN','UNAUTHORIZED'].includes(rpcErrorCode(error) ?? ''))
      if (error instanceof WorkspaceRequestError && error.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        retryAfterMs = (error.retryAfter ?? 1) * 1000
        next = { kind: 'loading', previous }
      } else {
        next = { kind: 'error', message: error instanceof Error ? error.message : String(error), previous }
      }
    }
    if (!isCurrent()) return
    if (denied) {
      this.denied.add(hostId)
      void disk?.clearDirectory()
      if (next.kind === 'error') next = { ...next, previous: null }
    } else if (next.kind === 'loaded') this.denied.delete(hostId)
    if (readPins) this.pins.set(hostId, readPins)
    if (!this.denied.has(hostId) && (next.kind === 'error' || next.kind === 'loading')) {
      const pending = this.stateOf(hostId)
      if (pending.kind === 'loading' && pending.previous) next = { ...next, previous: pending.previous }
    }
    this.set(hostId, next)
    if (next.kind === 'loaded' && (!next.value.indexing || next.value.threads.length)) {
      clearTimeout(this.directoryWrites.get(hostId))
      this.directoryWrites.delete(hostId)
      void disk?.saveDirectory(next.value)
    }
    if (next.kind === 'loaded') {
      const threads = next.value.threads
      const shared = this.shareArrivals.take(hostId, threads.map((thread) => thread.record))
        .map((record) => threads.find((thread) => thread.record === record)!)
      if (shared.length > 0) for (const listener of Array.from(this.shareListeners)) listener(shared)
    }
    // The initial index sweep has no completion event. Its empty first page is provisional.
    if (next.kind === 'loaded' && next.value.indexing && next.value.threads.length === 0) {
      this.retries.set(hostId, setTimeout(() => void this.load(hostId, 0, 'sessions'), 3000))
    }
    if (retryAfterMs !== null) this.retries.set(hostId, setTimeout(() => void this.load(hostId, attempt + 1, scope), retryAfterMs))
  }

  /** The list of a host as it shows now: its last read, or the rows it shows while it reads. */
  shownValue(hostId: string): HostThreads | null {
    const state = this.stateOf(hostId)
    return state.kind === 'loaded' ? state.value : state.kind === 'idle' ? null : state.previous
  }

  /**
   * The host's session shell changed (`SessionShells`). A live shell is the
   * host's loaded list; any other shell shows while the host connects or
   * synchronizes. A value that did not change moves nothing.
   */
  receiveShell(hostId: string, value: HostThreads, live: boolean): void {
    // A directory read in flight from before the shell no longer lands.
    this.requests.set(hostId, ++this.nextRequest)
    clearTimeout(this.retries.get(hostId))
    this.retries.delete(hostId)
    clearTimeout(this.directoryWrites.get(hostId))
    this.directoryWrites.delete(hostId)
    this.denied.delete(hostId)
    const prior = this.stateOf(hostId)
    if (prior.kind === (live ? 'loaded' : 'loading') && this.shownValue(hostId) === value) return
    this.set(hostId, live ? { kind: 'loaded', value } : { kind: 'loading', previous: value })
    if (!live) return
    const threads = value.threads
    const shared = this.shareArrivals.take(hostId, threads.map(thread => thread.record))
      .map(record => threads.find(thread => thread.record === record)!)
    if (shared.length) for (const listener of Array.from(this.shareListeners)) listener(shared)
  }

  /** The host's shell could not open: the list keeps its rows and shows the error. */
  shellFailed(hostId: string, message: string): void {
    const state = this.stateOf(hostId)
    if (state.kind === 'error' && state.message === message) return
    this.set(hostId, { kind: 'error', message, previous: this.shownValue(hostId) })
  }

  /** The host already sent the changed fields for listed sessions. A missing
   * record needs its membership and project before the list can insert it. */
  applyRowChanges(hostId: string, changes: ReadonlyMap<string, SessionRowChange>): string[] {
    const state = this.stateOf(hostId)
    const missing = new Set(changes.keys())
    if (!changes.size || state.kind !== 'loaded') return [...missing]
    const positions = this.positions.get(hostId)
    let threads: SolusThreadShell[] | undefined
    let orderChanged = false
    const replaced: SolusThreadShell[] = []
    for (const [id, delta] of changes) {
      const index = positions?.get(id)
      if (index === undefined) continue
      missing.delete(id)
      const thread = state.value.threads[index]!
      const record = thread.record
      const customTitle = delta.title !== undefined ? delta.title : record.customTitle
      const execution = delta.execution && (!record.execution || record.execution.revision < delta.execution.revision)
        ? delta.execution : record.execution
      const status = execution ? sessionRecordStatusOf(sessionExecutionStatus(execution)) : record.status
      const lastActivityAt = Math.max(record.lastActivityAt, execution?.current?.startedAt ?? execution?.lastTurn?.endedAt ?? 0)
      if (customTitle === record.customTitle && execution === record.execution) continue
      if (!orderChanged && lastActivityAt !== record.lastActivityAt) {
        // Activity only moves forward. A row below both preceding rows keeps
        // its place in both lists. Recheck equal times to preserve tie order.
        const visible = this.visiblePositions.get(thread.key)
        const hostBefore = state.value.threads[index - 1]
        const visibleBefore = visible === undefined ? undefined : this.merged.threads[visible - 1]
        orderChanged = visible === undefined || lastActivityAt >= (hostBefore?.record.lastActivityAt ?? Infinity)
          || lastActivityAt >= (visibleBefore?.record.lastActivityAt ?? Infinity)
      }
      threads ??= state.value.threads.slice()
      const next = { ...thread, record: { ...record, customTitle, status, lastActivityAt, execution } }
      threads[index] = next
      replaced.push(next)
    }
    if (threads) {
      const value = { ...state.value, revision: undefined, threads }
      if (orderChanged) {
        threads.sort((a, b) => b.record.lastActivityAt - a.record.lastActivityAt)
        this.set(hostId, { kind: 'loaded', value })
      } else {
        this.hosts.set(hostId, { kind: 'loaded', value })
        const positions: number[] = []
        let visible: SolusThreadShell[] | undefined
        for (const row of replaced) {
          const index = this.visiblePositions.get(row.key)
          if (index === undefined) continue
          visible ??= this.merged.threads.slice()
          visible[index] = row
          positions.push(index)
        }
        if (visible) {
          this.lastReplacement = { previous: this.merged.threads, positions }
          this.merged = { ...this.merged, threads: visible }
        }
        this.changes.notify()
      }
      this.scheduleDirectorySave(hostId)
    }
    return [...missing]
  }

  /** Read only records named by host events. Return false if a concurrent snapshot
   * or reconnect won, so the subscriber can retry against the new snapshot. */
  async refreshRecords(hostId: string, sessionIds: readonly string[]): Promise<boolean> {
    const connection = this.connectionFor(hostId)
    const host = this.registry.host(hostId)
    const request = this.requests.get(hostId)
    if (!connection || !host || this.stateOf(hostId).kind !== 'loaded') return false
    const generation = connection.state.sessionGeneration
    const records = await Promise.all(sessionIds.map(sessionId => connection.api.sessionRecordGet(sessionId)))
    const current = this.stateOf(hostId)
    if (this.requests.get(hostId) !== request || this.connectionFor(hostId) !== connection ||
        connection.state.sessionGeneration !== generation || current.kind !== 'loaded') return false
    const ids = new Set(sessionIds)
    const value = current.value
    const listed = value.threads.filter(thread => !ids.has(thread.record.sessionId))
    const unlisted = (value.unlisted ?? []).filter(thread => !ids.has(thread.record.sessionId))
    const children = new Map(this.children)
    for (const [index, record] of records.entries()) {
      const key = threadKey(hostId, sessionIds[index]!)
      this.openedSearchResults.delete(key)
      children.delete(key)
      if (!record) continue
      const row = { key, hostId, hostLabel: host.label, record }
      if (record.parentSessionId) children.set(key, row)
      else if (record.listed === false) unlisted.push(row)
      else listed.push(row)
    }
    const newest = (a: SolusThreadShell, b: SolusThreadShell) => b.record.lastActivityAt - a.record.lastActivityAt
    listed.sort(newest)
    unlisted.sort(newest)
    this.children = children
    const pinned = new Set(this.pins.get(hostId)?.map(pin => pin.sessionId))
    const next = { ...value, revision: undefined, threads: listed, unlisted: unlisted.filter((thread, index) => index < UNLISTED_LIMIT || pinned.has(thread.record.sessionId)) }
    this.set(hostId, { kind: 'loaded', value: next })
    this.scheduleDirectorySave(hostId)
    const shared = this.shareArrivals.take(hostId, listed.map(thread => thread.record))
      .map(record => listed.find(thread => thread.record === record)!)
    if (shared.length) for (const listener of this.shareListeners) listener(shared)
    return true
  }

  /** The projects and pins a read lists: a sessions read keeps the last whole
   *  read's, when there was one; otherwise both are read now. `projects` is
   *  null when kept, and `readPins` holds the pins this read answered. A failed
   *  pin read lists no pins now and is read again by the next whole read. */
  private async readProjectsAndPins(hostId: string, connection: HostConnection, keepsLastWholeRead: boolean): Promise<{ projects: ProjectEntry[] | null; pins: readonly PinnedSession[]; readPins: readonly PinnedSession[] | null }> {
    const heldPins = this.pins.get(hostId)
    if (keepsLastWholeRead && heldPins) return { projects: null, pins: heldPins, readPins: null }
    const [projects, readPins] = await Promise.all([connection.api.listProjects(), this.readPins(hostId, connection).catch(() => null)])
    return { projects, pins: readPins ?? [], readPins }
  }

  /** Reads the sessions one session started, for its agent cards. A host
   *  that cannot answer keeps the children read before. */
  async loadChildren(hostId: string, parentSessionId: string): Promise<void> {
    const connection = this.connectionFor(hostId)
    const host = this.registry.host(hostId)
    if (!connection || !host) return
    const answer = await connection.api.sessionRecordList({ parentSessionId }).catch(() => null)
    if (!answer || this.connectionFor(hostId) !== connection) return
    // A new map, so a reader of `childThreads` sees the change.
    const children = new Map(this.children)
    for (const record of answer.records) {
      const key = threadKey(hostId, record.sessionId)
      children.set(key, { key, hostId, hostLabel: host.label, record })
    }
    this.children = children
    this.changes.notify()
  }

  /** The child sessions read so far, replaced on each read. */
  childThreads = (): ReadonlyMap<string, SolusThreadShell> => this.children

  /** Save the newest directory once after a burst of row events. A full read
   * writes immediately; a removed host or a changed account cancels this write. */
  private scheduleDirectorySave(hostId: string): void {
    if (!this.cache || this.directoryWrites.has(hostId)) return
    const disk = this.cache.forHost(hostId)
    this.directoryWrites.set(hostId, setTimeout(() => {
      this.directoryWrites.delete(hostId)
      const state = this.stateOf(hostId)
      const value = state.kind === 'loaded' ? state.value : state.kind === 'idle' ? null : state.previous
      if (value && (!value.indexing || value.threads.length)) void disk.saveDirectory(value)
    }, 500))
  }

  forgetHost(hostId: string): void {
    this.restores.delete(hostId)
    this.presumed.delete(hostId)
    clearTimeout(this.retries.get(hostId))
    this.retries.delete(hostId)
    this.denied.delete(hostId)
    this.requests.delete(hostId)
    clearTimeout(this.directoryWrites.get(hostId))
    this.directoryWrites.delete(hostId)
    this.openingByHost.delete(hostId)
    this.hosts.delete(hostId)
    this.positions.delete(hostId)
    this.pins.delete(hostId)
    this.shareArrivals.forget(hostId)
    this.children = new Map([...this.children].filter(([, child]) => child.hostId !== hostId))
    this.openedSearchResults = new Map([...this.openedSearchResults].filter(([, thread]) => thread.hostId !== hostId))
    this.remerge()
  }

  private set(hostId: string, state: HostThreadsState): void {
    const value = state.kind === 'loaded' ? state.value : state.kind === 'idle' ? null : state.previous
    const prior = this.stateOf(hostId)
    const previous = prior.kind === 'loaded' ? prior.value : prior.kind === 'idle' ? null : prior.previous
    if (previous?.opening !== value?.opening) {
      const facts = value?.opening
      if (facts) this.openingByHost.set(hostId, {
        codebases: new Map(facts.codebases?.map(row => [row.id, row])),
        automations: new Map(facts.automations.map(row => [row.id, row.name])),
      })
      else this.openingByHost.delete(hostId)
    }
    this.hosts.set(hostId, state)
    if (previous === value) {
      this.changes.notify()
      return
    }
    if (previous?.threads !== value?.threads) this.positions.set(hostId, new Map(value?.threads.map((row, index) => [row.record.sessionId, index])))
    this.remerge()
  }

  private remerge(): void {
    const threads: SolusThreadShell[] = []
    const unlisted: SolusThreadShell[] = []
    const cloudHostIds = this.cloudHostIds()
    const listedByHost = new Set<string>()
    for (const [hostId, state] of this.hosts) {
      const value = state.kind === 'loaded' ? state.value : state.kind === 'idle' ? null : state.previous
      if (!value) continue
      for (const thread of value.threads) listedByHost.add(thread.record.sessionId)
      for (const thread of value.unlisted ?? []) listedByHost.add(thread.record.sessionId)
      // A personal host's threads show whole; a cloud machine's go through the organization (plans/031 rule 3).
      const usesFilter = usesWindowFilter(hostId, cloudHostIds)
      threads.push(...value.threads.filter((thread) => visibleInWindow(thread.record.organizationId, this.organizationId, usesFilter)))
      unlisted.push(...(value.unlisted ?? []).filter((thread) => visibleInWindow(thread.record.organizationId, this.organizationId, usesFilter)))
    }
    this.cloudShells = this.cloudOnlyShells(listedByHost)
    threads.push(...this.cloudShells.values())
    threads.sort((a, b) => b.record.lastActivityAt - a.record.lastActivityAt)
    unlisted.sort((a, b) => b.record.lastActivityAt - a.record.lastActivityAt)
    const projects = this.listedProjects()
    // A list whose items did not change keeps its array: a host that starts
    // reading again, or a change to sessions only, leaves the project list as it was.
    const held = this.merged
    const shownThreads = this.oneRowPerSession(threads, held.threads)
    const shownUnlisted = this.oneRowPerSession(unlisted, held.unlisted)
    this.lastReplacement = undefined
    const sameThreads = sameItems(shownThreads, held.threads)
    if (!sameThreads) {
      this.visiblePositions = new Map(shownThreads.map((row, index) => [row.key, index]))
    }
    this.merged = {
      threads: sameThreads ? held.threads : shownThreads,
      unlisted: sameItems(shownUnlisted, held.unlisted) ? held.unlisted : shownUnlisted,
      projects: sameItems(projects, held.projects) ? held.projects : projects,
    }
    this.changes.notify()
  }

  /** The projects that each host lists, by folder name, with no container root of a codebase. */
  private listedProjects(): SolusProjectShell[] {
    const projects: SolusProjectShell[] = []
    for (const [hostId, state] of this.hosts) {
      const value = state.kind === 'loaded' ? state.value : state.kind === 'idle' ? null : state.previous
      if (!value) continue
      for (const project of value.projects) {
        if (!this.isContainerRoot(hostId, project.project.path)) projects.push(project)
      }
    }
    return projects.sort((a, b) => a.project.folderName.localeCompare(b.project.folderName))
  }

  /** One row for each session only the cloud lists; a host's record of a session always wins. */
  private cloudOnlyShells(listedByHost: ReadonlySet<string>): Map<string, SolusThreadShell> {
    const shells = new Map<string, SolusThreadShell>()
    for (const { hostId, isLastRunHost, record } of this.cloud?.onlyInCloud((sessionId) => listedByHost.has(sessionId)) ?? []) {
      const hostLabel = isLastRunHost ? this.registry.host(hostId)?.label ?? CLOUD_LABEL : CLOUD_LABEL
      const kept = this.cloudShellOf.get(record)
      const shell: SolusThreadShell = kept?.hostId === hostId && kept.hostLabel === hostLabel
        ? kept
        : { key: threadKey(hostId, record.sessionId), hostId, hostLabel, record, cloudOnly: true }
      this.cloudShellOf.set(record, shell)
      shells.set(shell.key, shell)
    }
    return shells
  }

  /**
   * A session that ran on two hosts is in both hosts' lists. It shows once,
   * from the host with its newest turn (docs/plans/portable-sessions.md §9);
   * with no difference known, from the host that showed it before. The facts
   * of each such host are read once, and their answer draws the list again.
   */
  private oneRowPerSession(threads: SolusThreadShell[], shown: readonly SolusThreadShell[]): SolusThreadShell[] {
    const runHosts = this.runHosts
    if (!runHosts) return threads
    const bySession = new Map<string, SolusThreadShell[]>()
    for (const thread of threads) {
      const group = bySession.get(thread.record.sessionId)
      if (group) group.push(thread)
      else bySession.set(thread.record.sessionId, [thread])
    }
    if (bySession.size === threads.length) return threads
    const shownHost = new Map(shown.map((thread) => [thread.record.sessionId, thread.hostId]))
    const unknownByHost = new Map<string, string[]>()
    const kept = new Set<SolusThreadShell>()
    for (const [sessionId, group] of bySession) {
      if (group.length === 1) {
        kept.add(group[0]!)
        continue
      }
      const hostIds = group.map((thread) => thread.hostId)
      for (const hostId of hostIds) unknownByHost.set(hostId, [...(unknownByHost.get(hostId) ?? []), sessionId])
      const chosen = runHosts.turnsFor(sessionId).listedHost(hostIds, shownHost.get(sessionId) ?? null)
      kept.add(group.find((thread) => thread.hostId === chosen) ?? group[0]!)
    }
    for (const [hostId, sessionIds] of unknownByHost) runHosts.readOnce(hostId, sessionIds)
    return threads.filter((thread) => kept.has(thread))
  }
}
