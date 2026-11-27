import { z } from 'zod'
import { keepEqual, sameItems } from '@solus/client-core/keep-equal'
import type { HostApi } from '@solus/client-core/host-api'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { HostFacts } from '@solus/client-core/host-facts'
import type {
  SessionShellChange,
  SessionShellChanges,
  SessionShellCursor,
  SessionShellOpenResult,
  SessionShellRow,
  SessionShellSnapshot,
} from '@solus/contracts/session-shell'
import type { Codebase } from '@solus/contracts/codebases'
import type { PinnedSession, ProjectEntry } from '@solus/contracts/types'
import { Listeners } from '../../lib/listeners'
import { projectRows, threadKey, type HostThreads, type SolusThreadShell } from './thread-directory'

/**
 * The session list of each host as one shell: T3 Code's model
 * (`client-runtime/src/state/shell.ts`) over the Solus operation
 * `sessionShellOpen` and the event `sessionShell.changed`
 * (docs/plans/mobile-session-shell.md §6).
 *
 * The device keeps one record for each host and account scope. A start shows
 * it before the network (`cached`). On a ready connection the driver opens the
 * shell with the cursor of that record (`synchronizing`); after the answer it
 * follows the changes (`live`). A gap, a new connection, or a cursor that the
 * host cannot continue opens the shell again. The record is saved at most once
 * each 500 ms, when the sequence moves forward.
 */

/** T3's shell status (`EnvironmentShellStatus`). */
export type SessionShellStatus = 'empty' | 'cached' | 'synchronizing' | 'live'

/** What T3's release rule (`stepSteadyShells`) reads of one host's shell. */
export interface SessionShellProgress {
  readonly status: SessionShellStatus
  /** The cursor sequence: it moves with new server data only. */
  readonly sequence: number | null
  /** Grows with each snapshot the host sends, and with the first catch-up of a saved record. */
  readonly generation: number
}

/** The device table that keeps the records: T3's `client_cache`, kind `shell` (apps/mobile/src/solus/session-shell-store.ts). */
export interface SessionShellStore {
  load(hostId: string, scope: string): Promise<string | null>
  save(hostId: string, scope: string, payload: string): Promise<void>
  /** Removes every record of a host that this device forgets. */
  forget(hostId: string): Promise<void>
}

/** The part of a host connection the driver uses. */
export interface SessionShellConnection {
  readonly api: Pick<HostApi, 'sessionShellOpen'>
  readonly events: Pick<HostEventSubscriber, 'subscribe'>
  readonly state: { readonly readiness: string; readonly sessionGeneration: number }
}

interface SavedSessionShell {
  version: 1
  scope: string
  hostLabel: string
  snapshot: SessionShellSnapshot
}

const SAVE_DELAY_MS = 500

/**
 * Whether a host's list comes from its session shell: at once when its
 * capabilities are read, else when they are. A host that does not name the
 * capability keeps the directory reads (plan §5.4).
 */
export function readsSessionShell(facts: Pick<HostFacts, 'value' | 'when'>): boolean | Promise<boolean> {
  const capabilities = facts.value('capabilities')
  if (capabilities) return capabilities.sessionShell === true
  return facts.when('capabilities').then(read => read.sessionShell === true, () => false)
}

const newestFirst = (a: SessionShellRow, b: SessionShellRow) => b.record.lastActivityAt - a.record.lastActivityAt

/**
 * Applies changes in order: each change is the current state of its key, so a
 * row change replaces the row (plan §3). An unchanged row keeps its object, and
 * a snapshot with no changes stays the same object.
 */
export function applySessionShellChanges(snapshot: SessionShellSnapshot, { cursor, changes }: Pick<SessionShellChanges, 'cursor' | 'changes'>): SessionShellSnapshot {
  const next = new ShellEdit(snapshot)
  for (const change of changes) next.apply(change)
  const { codebases, indexing } = next
  const nextRows = next.rows ? [...next.rows.values()].sort(newestFirst) : snapshot.rows
  const nextProjects = next.projects ? [...next.projects.values()] : snapshot.projects
  const sameCursor = sameShellCursor(cursor, snapshot.cursor) && cursor.sequence === snapshot.cursor.sequence
  if (sameCursor && sameItems(nextRows, snapshot.rows) && sameItems(nextProjects, snapshot.projects) &&
      codebases === snapshot.codebases && indexing === snapshot.indexing) return snapshot
  return {
    cursor: sameCursor ? snapshot.cursor : cursor,
    rows: sameItems(nextRows, snapshot.rows) ? snapshot.rows : nextRows,
    projects: sameItems(nextProjects, snapshot.projects) ? snapshot.projects : nextProjects,
    codebases,
    indexing,
  }
}

/** The keyed state that changes write to: a map is made only for the part a change touches. */
class ShellEdit {
  rows: Map<string, SessionShellRow> | undefined
  projects: Map<string, ProjectEntry> | undefined
  codebases: SessionShellSnapshot['codebases']
  indexing: boolean

  constructor(private readonly snapshot: SessionShellSnapshot) {
    this.codebases = snapshot.codebases
    this.indexing = snapshot.indexing
  }

  apply(change: SessionShellChange): void {
    switch (change.kind) {
      case 'row.updated': {
        const rows = this.rowMap()
        const held = rows.get(change.row.record.sessionId)
        rows.set(change.row.record.sessionId, held ? keepRow(change.row, held) : change.row)
        return
      }
      case 'row.removed':
        this.rowMap().delete(change.sessionId)
        return
      case 'row.activity': {
        const rows = this.rowMap()
        const held = rows.get(change.sessionId)
        if (held && keepEqual(change.agentActivity, held.agentActivity) !== held.agentActivity) rows.set(change.sessionId, { ...held, agentActivity: change.agentActivity })
        return
      }
      case 'project.updated': {
        const projects = this.projectMap()
        const held = projects.get(change.project.path)
        projects.set(change.project.path, held ? keepEqual(change.project, held) : change.project)
        return
      }
      case 'project.removed':
        this.projectMap().delete(change.path)
        return
      case 'codebases.updated':
        this.codebases = this.codebases ? keepEqual(change.codebases, this.codebases) : change.codebases
        return
      case 'indexing.changed':
        this.indexing = change.indexing
    }
  }

  private rowMap(): Map<string, SessionShellRow> {
    return (this.rows ??= new Map(this.snapshot.rows.map(row => [row.record.sessionId, row])))
  }

  private projectMap(): Map<string, ProjectEntry> {
    return (this.projects ??= new Map(this.snapshot.projects.map(project => [project.path, project])))
  }
}

/** A new snapshot keeps each row and project the held one has unchanged. */
function keepSnapshotRows(next: SessionShellSnapshot, held: SessionShellSnapshot | null): SessionShellSnapshot {
  if (!held) return next
  const rows = new Map(held.rows.map(row => [row.record.sessionId, row]))
  const projects = new Map(held.projects.map(project => [project.path, project]))
  const nextRows = next.rows.map(row => {
    const prior = rows.get(row.record.sessionId)
    return prior ? keepRow(row, prior) : row
  })
  const nextProjects = next.projects.map(project => {
    const prior = projects.get(project.path)
    return prior ? keepEqual(project, prior) : project
  })
  return {
    ...next,
    rows: sameItems(nextRows, held.rows) ? held.rows : nextRows,
    projects: sameItems(nextProjects, held.projects) ? held.projects : nextProjects,
    codebases: next.codebases && held.codebases ? keepEqual(next.codebases, held.codebases) : next.codebases,
  }
}

/** A changed row keeps its unchanged record, so the list projects only what changed. */
function keepRow(next: SessionShellRow, held: SessionShellRow): SessionShellRow {
  const kept = keepEqual(next, held)
  if (kept === held) return held
  const record = keepEqual(next.record, held.record)
  return record === next.record ? next : { ...next, record }
}

function sameShellCursor(a: SessionShellCursor, b: SessionShellCursor): boolean {
  return a.epoch === b.epoch && a.scopeKey === b.scopeKey
}

/**
 * A saved record, checked before the driver trusts it. Each row, project, and
 * codebase is checked for the keys the driver reads; the rest is the host's
 * own snapshot, which this driver saved.
 */
const rowKeys = z.object({ record: z.object({ sessionId: z.string(), lastActivityAt: z.number() }) })
const projectKeys = z.object({ path: z.string() })
const codebaseKeys = z.object({ id: z.string() })
const savedShellSchema = z.object({
  version: z.literal(1),
  scope: z.string(),
  hostLabel: z.string(),
  snapshot: z.object({
    cursor: z.object({ epoch: z.string(), scopeKey: z.string(), sequence: z.number() }),
    rows: z.array(z.custom<SessionShellRow>(value => rowKeys.safeParse(value).success)),
    projects: z.array(z.custom<ProjectEntry>(value => projectKeys.safeParse(value).success)),
    codebases: z.array(z.custom<Codebase>(value => codebaseKeys.safeParse(value).success)).nullable(),
    indexing: z.boolean(),
  }),
})

function readSaved(payload: string, scope: string): SavedSessionShell | null {
  let parsed: ReturnType<typeof savedShellSchema.safeParse>
  try {
    parsed = savedShellSchema.safeParse(JSON.parse(payload))
  } catch {
    return null
  }
  return parsed.success && parsed.data.scope === scope ? parsed.data : null
}

/** The pins that the rows carry, as `ThreadListState` keeps them. */
export function shellPins(hostId: string, rows: readonly SessionShellRow[]): PinnedSession[] {
  return rows.flatMap(({ record, pinnedAt }) => pinnedAt === null ? [] : [{
    sessionId: record.sessionId,
    serverId: hostId,
    provider: record.provider,
    title: record.customTitle ?? record.title ?? 'Session',
    cwd: record.cwd ?? record.projectPath,
    pinnedAt,
  }])
}

const threadOfRow = new WeakMap<SessionShellRow, SolusThreadShell>()

/**
 * One host's shell as the thread directory holds it. A row that did not
 * change keeps its thread, and lists whose items did not change keep their
 * arrays, so an unchanged host does not move the list.
 */
export function shellHostThreads(hostId: string, hostLabel: string, snapshot: SessionShellSnapshot, previous: HostThreads | null): HostThreads {
  const thread = (row: SessionShellRow): SolusThreadShell => {
    const held = threadOfRow.get(row)
    if (held?.hostId === hostId && held.hostLabel === hostLabel) return held
    const next = { key: threadKey(hostId, row.record.sessionId), hostId, hostLabel, record: row.record }
    threadOfRow.set(row, next)
    return next
  }
  const listed = snapshot.rows.filter(row => row.record.listed !== false).map(thread)
  const unlisted = snapshot.rows.filter(row => row.record.listed === false).map(thread)
  const automations = new Map<string, string>()
  for (const { record, automationName } of snapshot.rows) {
    if (record.startedBy?.kind === 'automation' && automationName !== null) automations.set(record.startedBy.automationId, automationName)
  }
  const nextOpening = {
    pins: shellPins(hostId, snapshot.rows),
    codebases: snapshot.codebases,
    automations: [...automations].map(([id, name]) => ({ id, name })),
  }
  const opening = previous?.opening ? keepEqual(nextOpening, previous.opening) : nextOpening
  const threads = previous && sameItems(listed, previous.threads) ? previous.threads : listed
  const heldUnlisted = previous?.unlisted
  const unlistedRows = heldUnlisted && sameItems(unlisted, heldUnlisted) ? heldUnlisted : unlisted
  const projects = projectRows(hostId, hostLabel, snapshot.projects, previous?.projects)
  if (previous && previous.opening === opening && previous.threads === threads && previous.unlisted === unlistedRows &&
      previous.projects === projects && previous.indexing === snapshot.indexing && previous.revision === undefined) return previous
  return { opening, threads, unlisted: unlistedRows, projects, indexing: snapshot.indexing }
}

interface HostShell {
  readonly scope: string
  hostLabel: string
  snapshot: SessionShellSnapshot | null
  status: SessionShellStatus
  generation: number
  error: string | null
  /** The open in flight or answered last; an answer to an older open is dropped. */
  request: number
  connection: SessionShellConnection | null
  stopEvents: (() => void) | null
  /** The connection session the shell was opened on; null until an open on this connection. */
  openedGeneration: number | null
  /** Changes that came while the open waits for its answer. */
  pending: SessionShellChanges[]
  savedSequence: number | null
  savedEpoch: string | null
  saveTimer: ReturnType<typeof setTimeout> | undefined
  restore: Promise<SavedSessionShell | null> | null
}

/** Shared by every host, so a reopened shell never reuses a generation another used. */
let lastGeneration = 0

export interface SessionShellsDeps {
  readonly store?: SessionShellStore
  /** The account scope the device copies belong to: the saved scope until the account is read. */
  readonly scope: () => string
  readonly connectionFor: (hostId: string) => SessionShellConnection | null
  readonly setTimeoutFn?: typeof setTimeout
  readonly clearTimeoutFn?: typeof clearTimeout
}

/** The shell driver of every host that has the `sessionShell` capability. */
export class SessionShells {
  /** Hears the host whose shell, status, or error changed. */
  readonly changes = new Listeners()
  private readonly hostChanges = new Set<(hostId: string) => void>()
  private readonly hosts = new Map<string, HostShell>()
  /** The hosts this driver follows now (`follow`), until `stop` or `forgetHost`. */
  private readonly followed = new Set<string>()
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout

  constructor(private readonly deps: SessionShellsDeps) {
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout
  }

  /** Hears one host at a time: the host whose shell, status, or error changed. */
  subscribeHosts(listener: (hostId: string) => void): () => void {
    this.hostChanges.add(listener)
    return () => { this.hostChanges.delete(listener) }
  }

  statusOf = (hostId: string): SessionShellStatus => this.current(hostId)?.status ?? 'empty'

  snapshotOf(hostId: string): SessionShellSnapshot | null {
    return this.current(hostId)?.snapshot ?? null
  }

  /** The label the shell's rows were saved with; the registry's label wins once it knows the host. */
  savedLabelOf(hostId: string): string | null {
    return this.current(hostId)?.hostLabel ?? null
  }

  errorOf(hostId: string): string | null {
    return this.current(hostId)?.error ?? null
  }

  progressOf(hostId: string): SessionShellProgress {
    const host = this.current(hostId)
    return { status: host?.status ?? 'empty', sequence: host?.snapshot?.cursor.sequence ?? null, generation: host?.generation ?? 0 }
  }

  /** True while the driver follows the host: its list comes from the shell, not from the directory reads. */
  follows = (hostId: string): boolean => this.followed.has(hostId)

  /**
   * Reads the saved record of the host in the current scope, once for each
   * scope. Its snapshot is the shell's `cached` state. A record of another
   * scope is never read: the scope is in the record's key and in the record.
   */
  restore(hostId: string, hostLabel = ''): Promise<SessionShellSnapshot | null> {
    const host = this.entry(hostId, hostLabel)
    if (!this.deps.store) return Promise.resolve(null)
    host.restore ??= this.deps.store.load(hostId, host.scope).then(payload => {
      if (payload === null || this.hosts.get(hostId) !== host || this.deps.scope() !== host.scope) return null
      const saved = readSaved(payload, host.scope)
      if (!saved || host.snapshot) return null
      host.snapshot = saved.snapshot
      host.hostLabel ||= saved.hostLabel
      host.savedSequence = saved.snapshot.cursor.sequence
      host.savedEpoch = saved.snapshot.cursor.epoch
      if (host.status === 'empty') host.status = 'cached'
      return saved
    }, () => null)
    return host.restore.then(saved => saved && this.hosts.get(hostId) === host ? host.snapshot : null)
  }

  /** Follows the host: opens the shell on each ready connection and applies its changes. */
  follow(hostId: string, hostLabel = ''): void {
    this.followed.add(hostId)
    const host = this.entry(hostId, hostLabel)
    if (hostLabel) host.hostLabel = hostLabel
    this.sync(hostId)
  }

  /**
   * Follows the connection's state: a ready connection with a new server
   * session opens the shell again; a connection that is not ready leaves the
   * shell `cached` until it is.
   */
  sync(hostId: string): void {
    if (!this.followed.has(hostId)) return
    const host = this.entry(hostId)
    const connection = this.deps.connectionFor(hostId)
    if (connection !== host.connection) {
      host.stopEvents?.()
      host.connection = connection
      host.openedGeneration = null
      host.stopEvents = connection?.events.subscribe('sessionShell.changed', changes => this.receive(hostId, host, connection, changes)) ?? null
    }
    if (!connection || connection.state.readiness !== 'ready') {
      this.disconnect(hostId, host)
      return
    }
    if (host.openedGeneration !== connection.state.sessionGeneration) void this.open(hostId, host)
  }

  /** Opens the shell again when it is not live: after an error, or on the person's refresh. */
  reload(hostId: string): void {
    const host = this.current(hostId)
    if (!host || !this.followed.has(hostId) || host.status === 'live' || host.status === 'synchronizing') return
    host.openedGeneration = null
    this.sync(hostId)
  }

  /** Stops following the host; its shell stays for the list until the host or the scope goes. */
  stop(hostId: string): void {
    this.followed.delete(hostId)
    const host = this.hosts.get(hostId)
    if (!host) return
    host.stopEvents?.()
    host.stopEvents = null
    host.connection = null
    this.disconnect(hostId, host)
  }

  /** The device forgets the host: its shell and its saved records go. */
  forgetHost(hostId: string): void {
    this.stop(hostId)
    const host = this.hosts.get(hostId)
    if (host) this.drop(hostId, host)
    void this.deps.store?.forget(hostId).catch(() => {})
  }

  /** The account scope changed: every shell of the old scope goes, and no read or save of it lands later. */
  reset(): void {
    for (const [hostId, host] of [...this.hosts]) {
      host.stopEvents?.()
      this.drop(hostId, host)
    }
    this.followed.clear()
  }

  private drop(hostId: string, host: HostShell): void {
    this.clearTimeoutFn(host.saveTimer)
    host.request++
    this.hosts.delete(hostId)
    this.notify(hostId)
  }

  private current(hostId: string): HostShell | undefined {
    const host = this.hosts.get(hostId)
    return host?.scope === this.deps.scope() ? host : undefined
  }

  private entry(hostId: string, hostLabel = ''): HostShell {
    const scope = this.deps.scope()
    const held = this.hosts.get(hostId)
    if (held?.scope === scope) return held
    if (held) {
      // An old scope never fills a new one.
      held.stopEvents?.()
      this.clearTimeoutFn(held.saveTimer)
      held.request++
    }
    const host: HostShell = {
      scope, hostLabel, snapshot: null, status: 'empty', generation: 0, error: null, request: 0,
      connection: null, stopEvents: null, openedGeneration: null, pending: [],
      savedSequence: null, savedEpoch: null, saveTimer: undefined, restore: null,
    }
    this.hosts.set(hostId, host)
    return host
  }

  private disconnect(hostId: string, host: HostShell): void {
    host.request++
    host.pending = []
    host.openedGeneration = null
    const status = host.snapshot ? 'cached' : 'empty'
    if (host.status === status) return
    host.status = status
    this.notify(hostId)
  }

  private async open(hostId: string, host: HostShell, fresh = false): Promise<void> {
    const connection = host.connection
    if (!connection) return
    // Claimed at once: `sync` runs on each connection change, and one open serves this server session.
    const generation = connection.state.sessionGeneration
    const request = ++host.request
    host.openedGeneration = generation
    host.pending = []
    if (host.status !== 'synchronizing') {
      host.status = 'synchronizing'
      this.notify(hostId)
    }
    const isCurrent = () => host.request === request && this.hosts.get(hostId) === host &&
      host.connection === connection && connection.state.sessionGeneration === generation && this.deps.scope() === host.scope
    // A start reads its saved record before the first open, so the open sends its cursor.
    if (host.restore) await host.restore
    if (!isCurrent()) return
    const after = fresh ? undefined : host.snapshot?.cursor
    let answer: SessionShellOpenResult
    try {
      answer = await connection.api.sessionShellOpen(after ? { after } : {})
    } catch (error) {
      if (!isCurrent()) return
      host.error = error instanceof Error ? error.message : String(error)
      host.status = host.snapshot ? 'cached' : 'empty'
      host.pending = []
      this.notify(hostId)
      return
    }
    if (!isCurrent()) return
    if (!this.takeAnswer(host, answer)) {
      // The host continued a cursor this device does not hold: one snapshot sets it right.
      void this.open(hostId, host, true)
      return
    }
    host.error = null
    host.status = 'live'
    // The changes that came during the open, in order; a gap among them opens again.
    const pending = host.pending.sort((a, b) => a.fromSequence - b.fromSequence)
    host.pending = []
    const gap = pending.some(changes => this.apply(host, changes) === 'gap')
    this.notify(hostId)
    this.scheduleSave(hostId, host)
    if (gap) void this.open(hostId, host)
  }

  /** Applies an open's answer; false when it continues a cursor this shell does not hold. */
  private takeAnswer(host: HostShell, answer: SessionShellOpenResult): boolean {
    if (answer.kind === 'snapshot') {
      host.snapshot = keepSnapshotRows(answer.snapshot, host.snapshot)
      host.generation = ++lastGeneration
      return true
    }
    const held = host.snapshot
    if (!held || !sameShellCursor(answer.cursor, held.cursor) || answer.fromSequence > held.cursor.sequence) return false
    host.snapshot = applySessionShellChanges(held, answer)
    if (host.generation === 0) host.generation = ++lastGeneration
    return true
  }

  private receive(hostId: string, host: HostShell, connection: SessionShellConnection, changes: SessionShellChanges): void {
    if (this.hosts.get(hostId) !== host || host.connection !== connection) return
    if (host.status === 'synchronizing') {
      host.pending.push(changes)
      return
    }
    // A shell that is not open on this connection reads these changes with its next open.
    if (host.status !== 'live') return
    const before = host.snapshot
    const result = this.apply(host, changes)
    if (result === 'gap') {
      void this.open(hostId, host)
      return
    }
    if (host.snapshot === before) return
    this.notify(hostId)
    this.scheduleSave(hostId, host)
  }

  private apply(host: HostShell, changes: SessionShellChanges): 'applied' | 'gap' {
    const held = host.snapshot
    if (!held || !sameShellCursor(changes.cursor, held.cursor) || changes.fromSequence > held.cursor.sequence) return 'gap'
    // Changes this shell holds already (an open answered them) change nothing.
    if (changes.cursor.sequence <= held.cursor.sequence) return 'applied'
    host.snapshot = applySessionShellChanges(held, changes)
    return 'applied'
  }

  /** Saves the shell once after a burst of changes, when its sequence moved forward. */
  private scheduleSave(hostId: string, host: HostShell): void {
    if (!this.deps.store || host.saveTimer !== undefined) return
    const store = this.deps.store
    host.saveTimer = this.setTimeoutFn(() => {
      host.saveTimer = undefined
      const snapshot = host.snapshot
      if (!snapshot || this.hosts.get(hostId) !== host || this.deps.scope() !== host.scope) return
      // A first index sweep that has no rows yet is not final: the record keeps the last whole list.
      if (snapshot.indexing && !snapshot.rows.length) return
      if (host.savedEpoch === snapshot.cursor.epoch && host.savedSequence !== null && snapshot.cursor.sequence <= host.savedSequence) return
      host.savedEpoch = snapshot.cursor.epoch
      host.savedSequence = snapshot.cursor.sequence
      const saved: SavedSessionShell = { version: 1, scope: host.scope, hostLabel: host.hostLabel, snapshot }
      void store.save(hostId, host.scope, JSON.stringify(saved)).catch(() => {})
    }, SAVE_DELAY_MS)
  }

  private notify(hostId: string): void {
    for (const listener of [...this.hostChanges]) listener(hostId)
    this.changes.notify()
  }
}

/** A memory store, for tests and builds with no device database: records by host, then by scope. */
export function memorySessionShellStore(): SessionShellStore {
  const records = new Map<string, Map<string, string>>()
  return {
    load: async (hostId, scope) => records.get(hostId)?.get(scope) ?? null,
    save: async (hostId, scope, payload) => {
      const host = records.get(hostId) ?? new Map<string, string>()
      host.set(scope, payload)
      records.set(hostId, host)
    },
    forget: async (hostId) => { records.delete(hostId) },
  }
}
