import { createHash, randomUUID } from 'node:crypto'
import type { AgentActivity } from '@solus/contracts/agent-activity'
import type { AttentionEntry } from '@solus/contracts/attention-types'
import type { Codebase } from '@solus/contracts/codebases'
import type { HostEvent } from '@solus/contracts/host-events'
import type { SessionShellChange, SessionShellChanges, SessionShellCursor, SessionShellOpenResult, SessionShellRow, SessionShellSnapshot } from '@solus/contracts/session-shell'
import type { ProjectEntry } from '@solus/contracts/types'
import { actorFor, ownerKeyOf } from '../../admission/actor'
import { isAnyOrganization, recordScopeOf, type Principal } from '../../admission/principal'
import { createLogger } from '../../logger'
import type { CallerCtx } from '../server'

const log = createLogger('server', 'session-shell.ts')

/** The change log keeps the newest keys only: this many, and none older than `LOG_AGE_MS`. */
export const SESSION_SHELL_LOG_LIMIT = 2_000
export const SESSION_SHELL_LOG_AGE_MS = 10 * 60 * 1000
/** Keys that change inside this window go to a client in one event. */
export const SESSION_SHELL_COALESCE_MS = 50

/** What the shell reads for one caller, with that caller's scope. `agentActivity` is the shell's to add. */
export interface SessionShellReads {
  snapshot(caller: CallerCtx): Promise<Omit<SessionShellSnapshot, 'cursor'>>
  /** The rows of these sessions that are in the caller's list. A session they cannot read, or that is out of their list, has none. */
  sessions(caller: CallerCtx, sessionIds: readonly string[]): Promise<Map<string, SessionShellRow>>
  projects(caller: CallerCtx): Promise<ProjectEntry[]>
  codebases(caller: CallerCtx): Promise<Codebase[] | null>
  indexing(): boolean
}

export interface SessionShellDeps {
  reads: SessionShellReads
  /** Hands one client its own changes (`sessionShell.changed`). */
  publish(clientId: string, changes: SessionShellChanges): void
  /** The host's projects, before any caller's filter: a change to this list names the paths that changed. */
  hostProjects(): Promise<readonly Pick<ProjectEntry, 'path'>[]>
  /** The sessions an automation started: their rows show its name. */
  sessionsStartedBy(automationId: string): Promise<string[]>
  now?: () => number
}

type ShellKey = `session:${string}` | `project:${string}` | 'codebases' | 'indexing'

interface Subscriber {
  caller: CallerCtx
  scopeKey: string
  /** The sequence of the copy the client holds: the `fromSequence` of its next event. */
  held: number
  /** The last sequence read for this client. Keys up to it that changed nothing for the client are done. */
  readThrough: number
}

/**
 * A digest of what decides a caller's rows: the person, the organization
 * scope, and what else widens or narrows their reads. Two callers with one
 * key read the same list; a cursor from another key gets a snapshot.
 */
export function sessionShellScopeKey(principal: Principal): string {
  const scope = recordScopeOf(principal)
  const parts = [
    principal.kind,
    ownerKeyOf(actorFor(principal)),
    isAnyOrganization(scope) ? '*' : scope,
    principal.kind === 'org-member' ? [principal.organizationRole, [...principal.teamIds].sort()] : null,
    principal.kind === 'guest' ? [principal.share.resource.kind, principal.share.resource.id] : null,
  ]
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
}

/**
 * The session list of each person on this host as a sequence of changed keys
 * (docs/plans/mobile-session-shell.md §5). The log keeps keys, not rows: each
 * client reads the current state of a key with its own scope, so one caller
 * never gets another caller's row. A key is in the log once, at its newest
 * sequence.
 *
 * A `row.removed` or `project.removed` goes to a caller only for a key that
 * this process sent to their scope before: a caller never learns the id of a
 * session or the path of a project they could not read.
 */
export class SessionShell {
  readonly epoch = randomUUID()
  private sequence = 0
  /** The highest sequence the log let go: a cursor before it cannot be continued. */
  private droppedThrough = 0
  /** Key to its newest sequence and time, in sequence order. */
  private readonly log = new Map<ShellKey, { sequence: number; at: number }>()
  private readonly subscribers = new Map<string, Subscriber>()
  /** Opens that still read: a client that leaves meanwhile is not followed after its read. */
  private readonly opening = new Map<string, Subscriber>()
  /** The keys sent to each scope in this process: what a cursor of that scope can hold. */
  private readonly sentTo = new Map<string, Set<ShellKey>>()
  private readonly activity = new Map<string, AgentActivity>()
  private attention = new Map<string, string>()
  private projects: Promise<Map<string, string> | null>
  private readonly automationNames = new Map<string, string>()
  private indexing: boolean
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing: Promise<void> = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly deps: SessionShellDeps) {
    this.now = deps.now ?? Date.now
    this.indexing = deps.reads.indexing()
    this.projects = this.readHostProjects()
  }

  /** Answer `sessionShellOpen`. The caller follows the shell from now until `disconnected`. */
  async open(caller: CallerCtx, after: SessionShellCursor | undefined): Promise<SessionShellOpenResult> {
    // An earlier follow of this client ends here: no event of it may arrive after this answer.
    this.subscribers.delete(caller.clientId)
    this.trim()
    const scopeKey = sessionShellScopeKey(caller.principal)
    const through = this.sequence
    const cursor = { epoch: this.epoch, scopeKey, sequence: through }
    const subscriber: Subscriber = { caller: followerOf(caller), scopeKey, held: through, readThrough: through }
    this.opening.set(caller.clientId, subscriber)
    if (after && after.epoch === this.epoch && after.scopeKey === scopeKey && after.sequence >= this.droppedThrough && after.sequence <= through) {
      const changes = await this.changesFor(subscriber, this.keysAfter(after.sequence, through))
      this.follow(caller.clientId, subscriber)
      return { kind: 'changes', fromSequence: after.sequence, cursor, changes }
    }
    const read = await this.deps.reads.snapshot(caller)
    const sent = this.sentKeys(scopeKey)
    for (const row of read.rows) {
      sent.add(`session:${row.record.sessionId}`)
      row.agentActivity = this.activity.get(row.record.sessionId) ?? null
    }
    for (const project of read.projects) sent.add(`project:${project.path}`)
    this.follow(caller.clientId, subscriber)
    return { kind: 'snapshot', snapshot: { cursor, ...read } }
  }

  /** The client's connection closed: it hears nothing more. */
  disconnected(clientId: string): void {
    this.subscribers.delete(clientId)
    this.opening.delete(clientId)
  }

  /** A host event: the keys it changes go into the log. */
  observe(event: HostEvent): void {
    switch (event.type) {
      case 'session.titleChanged':
      case 'session.forkCreated':
      case 'session.pullRequestsChanged':
      case 'session.stateChanged':
      case 'session.statusChanged':
        this.sessionChanged(event.payload.sessionId)
        break
      case 'session.executionChanged':
        // A sub-agent's execution is not on the row.
        if (!event.payload.toolId) this.sessionChanged(event.payload.sessionId)
        break
      case 'session.activityChanged':
        if (event.payload.activity) this.activity.set(event.payload.sessionId, event.payload.activity)
        else this.activity.delete(event.payload.sessionId)
        this.sessionChanged(event.payload.sessionId)
        break
      case 'session.indexChanged':
        for (const sessionId of event.payload.sessionIds) this.sessionChanged(sessionId)
        this.checkIndexing()
        break
      case 'share.changed':
        if (event.payload.resource.kind === 'session') this.sessionChanged(event.payload.resource.id)
        break
      case 'codebases.changed':
        this.record('codebases')
        break
      case 'projects.changed':
        this.projectsChanged()
        break
      case 'automation.changed':
        this.automationChanged(event.payload)
        break
    }
  }

  /** A change that names one session: a record write or delete, a person's view, read state, or pin. */
  sessionChanged(sessionId: string): void {
    this.record(`session:${sessionId}`)
    this.checkIndexing()
  }

  /** The host's attention entries now: each session whose entry came, went, or changed moves. */
  attentionChanged(entries: readonly AttentionEntry[]): void {
    const next = new Map(entries.map(entry => [entry.sessionId, JSON.stringify(entry)]))
    for (const [sessionId, entry] of next) if (this.attention.get(sessionId) !== entry) this.sessionChanged(sessionId)
    for (const sessionId of this.attention.keys()) if (!next.has(sessionId)) this.sessionChanged(sessionId)
    this.attention = next
  }

  private automationChanged(change: Extract<HostEvent, { type: 'automation.changed' }>['payload']): void {
    if (change.kind === 'deleted') {
      this.automationNames.delete(change.automationId)
      void this.automationSessionsChanged(change.automationId)
      return
    }
    const { id, name } = change.automation
    const known = this.automationNames.get(id)
    this.automationNames.set(id, name)
    // A run carries the automation as it is; only a save renames it. A save this process has not seen a name for may be a rename.
    if (change.kind === 'saved' && known !== name) void this.automationSessionsChanged(id)
  }

  private async automationSessionsChanged(automationId: string): Promise<void> {
    try {
      for (const sessionId of await this.deps.sessionsStartedBy(automationId)) this.sessionChanged(sessionId)
    } catch (error) {
      log.warn('session_shell_automation_sessions_failed', { automationId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private checkIndexing(): void {
    const indexing = this.deps.reads.indexing()
    if (indexing === this.indexing) return
    this.indexing = indexing
    this.record('indexing')
  }

  private async readHostProjects(): Promise<Map<string, string> | null> {
    try {
      const projects = await this.deps.hostProjects()
      return new Map(projects.map(project => [project.path, JSON.stringify(project)]))
    } catch (error) {
      log.warn('session_shell_projects_read_failed', { error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /** The project list changed: each path that came, went, or changed moves. One read at a time keeps the diffs in order. */
  private projectsChanged(): void {
    this.projects = this.projects.then(async (previous) => {
      const next = await this.readHostProjects()
      if (!next) return previous
      for (const [path, project] of next) if (previous?.get(path) !== project) this.record(`project:${path}`)
      for (const path of previous?.keys() ?? []) if (!next.has(path)) this.record(`project:${path}`)
      return next
    })
  }

  private record(key: ShellKey): void {
    this.sequence++
    this.log.delete(key)
    this.log.set(key, { sequence: this.sequence, at: this.now() })
    this.trim()
    if (this.subscribers.size) this.scheduleFlush()
  }

  private trim(): void {
    const oldest = this.now() - SESSION_SHELL_LOG_AGE_MS
    for (const [key, entry] of this.log) {
      if (this.log.size <= SESSION_SHELL_LOG_LIMIT && entry.at >= oldest) break
      this.log.delete(key)
      this.droppedThrough = entry.sequence
    }
  }

  /** The keys whose newest change is after `after` and no later than `through`, oldest first. */
  private keysAfter(after: number, through: number): ShellKey[] {
    const keys: ShellKey[] = []
    for (const [key, entry] of this.log) if (entry.sequence > after && entry.sequence <= through) keys.push(key)
    return keys
  }

  private sentKeys(scopeKey: string): Set<ShellKey> {
    let sent = this.sentTo.get(scopeKey)
    if (!sent) this.sentTo.set(scopeKey, sent = new Set())
    return sent
  }

  /** The current state of each key for this subscriber's caller. */
  private async changesFor(subscriber: Subscriber, keys: readonly ShellKey[]): Promise<SessionShellChange[]> {
    const { caller, scopeKey } = subscriber
    const sessionIds = keys.flatMap(key => key.startsWith('session:') ? [key.slice('session:'.length)] : [])
    const hasProjects = keys.some(key => key.startsWith('project:'))
    const [rows, projects, codebases] = await Promise.all([
      sessionIds.length ? this.deps.reads.sessions(caller, sessionIds) : null,
      hasProjects ? this.deps.reads.projects(caller) : null,
      keys.includes('codebases') ? this.deps.reads.codebases(caller) : null,
    ])
    const projectByPath = new Map(projects?.map(project => [project.path, project]))
    const sent = this.sentKeys(scopeKey)
    const changes: SessionShellChange[] = []
    for (const key of keys) {
      if (key === 'codebases') {
        if (codebases) changes.push({ kind: 'codebases.updated', codebases })
      } else if (key === 'indexing') {
        changes.push({ kind: 'indexing.changed', indexing: this.deps.reads.indexing() })
      } else if (key.startsWith('session:')) {
        const sessionId = key.slice('session:'.length)
        const row = rows?.get(sessionId)
        if (row) {
          sent.add(key)
          changes.push({ kind: 'row.updated', row: { ...row, agentActivity: this.activity.get(sessionId) ?? null } })
        } else if (sent.has(key)) {
          changes.push({ kind: 'row.removed', sessionId })
        }
      } else {
        const path = key.slice('project:'.length)
        const project = projectByPath.get(path)
        if (project) {
          sent.add(key)
          changes.push({ kind: 'project.updated', project })
        } else if (sent.has(key)) {
          changes.push({ kind: 'project.removed', path })
        }
      }
    }
    return changes
  }

  private follow(clientId: string, subscriber: Subscriber): void {
    if (this.opening.get(clientId) !== subscriber) return
    this.opening.delete(clientId)
    this.subscribers.set(clientId, subscriber)
    // A change that came while the open read its rows goes out now.
    if (this.sequence > subscriber.readThrough) this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flushing = this.flushing.then(() => this.flush())
    }, SESSION_SHELL_COALESCE_MS)
  }

  private async flush(): Promise<void> {
    const through = this.sequence
    await Promise.all([...this.subscribers].map(async ([clientId, subscriber]) => {
      if (subscriber.readThrough >= through) return
      if (subscriber.readThrough < this.droppedThrough) {
        // The client fell behind the log: an event that does not continue its copy makes it open the shell again.
        this.subscribers.delete(clientId)
        this.deps.publish(clientId, { fromSequence: through, cursor: { epoch: this.epoch, scopeKey: subscriber.scopeKey, sequence: through }, changes: [] })
        return
      }
      let changes: SessionShellChange[]
      try {
        changes = await this.changesFor(subscriber, this.keysAfter(subscriber.readThrough, through))
      } catch (error) {
        // The keys stay unread for this client; its next change reads them again.
        log.warn('session_shell_changes_failed', { clientId, error: error instanceof Error ? error.message : String(error) })
        return
      }
      // The client opened again or left while its rows were read.
      if (this.subscribers.get(clientId) !== subscriber) return
      subscriber.readThrough = through
      if (!changes.length) return
      const fromSequence = subscriber.held
      subscriber.held = through
      this.deps.publish(clientId, { fromSequence, cursor: { epoch: this.epoch, scopeKey: subscriber.scopeKey, sequence: through }, changes })
    }))
  }
}

/** The caller as a follower keeps it: who it is, never a signal of the request that opened it. */
function followerOf(caller: CallerCtx): CallerCtx {
  const { abortSignal: _abortSignal, renewAccess: _renewAccess, ...follower } = caller
  return follower
}
