import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import type { ProjectEntry, SessionRecord } from '@solus/contracts/types'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'
import type { HostRegistry } from '../hosts/host-registry'

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

export interface HostThreads {
  readonly threads: readonly SolusThreadShell[]
  /** Sessions another session started. They open from their parent's agent
   *  cards, not from the list. */
  readonly children?: readonly SolusThreadShell[]
  /** The most recently active archived sessions: search finds them and a
   *  thread screen opens one, but the list does not show them. */
  readonly archived?: readonly SolusThreadShell[]
  readonly projects: readonly SolusProjectShell[]
  /** The host's first index sweep is still running: the list is not final. */
  readonly indexing: boolean
}

/** Every readable host's threads and projects, as one sorted snapshot. */
interface MergedThreads {
  readonly threads: readonly SolusThreadShell[]
  readonly archived: readonly SolusThreadShell[]
  readonly projects: readonly SolusProjectShell[]
}

export function threadKey(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`
}

/** How many archived sessions a host is asked for. The list itself has no
 *  limit: the archive bounds it (docs/plans/session-archive.md). */
const ARCHIVED_LIMIT = 200

/** A host that is over its request budget keeps the list it showed; it is read again
 *  after the wait the host asks for, this many times before the error shows. */
const RATE_LIMIT_RETRIES = 3

const IDLE = { kind: 'idle' } as const

export class ThreadDirectory {
  readonly changes = new Listeners()
  private readonly hosts = new Map<string, HostThreadsState>()
  private readonly requests = new Map<string, number>()
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  private nextRequest = 0
  /** A stable snapshot, replaced only when a host's state changes. */
  private merged: MergedThreads = { threads: [], archived: [], projects: [] }
  private children = new Map<string, SolusThreadShell>()

  constructor(
    private readonly registry: HostRegistry,
    private readonly connectionFor: (hostId: string) => HostConnection | null,
  ) {}

  stateOf = (hostId: string): HostThreadsState => this.hosts.get(hostId) ?? IDLE

  /** Every readable host's sessions, newest activity first. Delegated child
   *  sessions open from their parent's transcript, not the list. */
  threads = (): readonly SolusThreadShell[] => this.merged.threads

  /** Every readable host's recent archived sessions, newest activity first. */
  archivedThreads = (): readonly SolusThreadShell[] => this.merged.archived

  projects = (): readonly SolusProjectShell[] => this.merged.projects

  /** A listed or archived session, or a child session its parent's agent card opens. */
  thread = (hostId: string, sessionId: string): SolusThreadShell | null =>
    this.merged.threads.find((thread) => thread.key === threadKey(hostId, sessionId))
      ?? this.merged.archived.find((thread) => thread.key === threadKey(hostId, sessionId))
      ?? this.children.get(threadKey(hostId, sessionId))
      ?? null

  /** True while any known host has not answered its first read. */
  isLoading = (): boolean =>
    this.registry.hosts().some((host) => {
      const state = this.stateOf(host.id)
      return state.kind === 'idle' || (state.kind === 'loading' && state.previous === null)
    })

  async loadAll(): Promise<void> {
    await Promise.all(this.registry.hosts().map((host) => this.load(host.id)))
  }

  async load(hostId: string, attempt = 0): Promise<void> {
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
    const request = ++this.nextRequest
    const generation = connection.state.sessionGeneration
    this.requests.set(hostId, request)
    this.set(hostId, { kind: 'loading', previous })
    let next: HostThreadsState
    let retryAfterMs: number | null = null
    try {
      const [list, archived, projects] = await Promise.all([
        connection.api.sessionRecordList({ includeWorktrees: true, archived: false }),
        connection.api.sessionRecordList({ includeWorktrees: true, archived: true, limit: ARCHIVED_LIMIT }),
        connection.api.listProjects(),
      ])
      const shell = (record: SessionRecord): SolusThreadShell => ({ key: threadKey(hostId, record.sessionId), hostId, hostLabel: host.label, record })
      const shells = list.records.map(shell)
      next = {
        kind: 'loaded',
        value: {
          threads: shells.filter((shell) => shell.record.parentSessionId === null),
          children: shells.filter((shell) => shell.record.parentSessionId !== null),
          archived: archived.records.filter((record) => record.parentSessionId === null).map(shell),
          projects: projects.map((project) => ({ key: `${hostId}\u0000${project.path}`, hostId, hostLabel: host.label, project })),
          indexing: list.indexing,
        },
      }
    } catch (error) {
      if (error instanceof WorkspaceRequestError && error.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        retryAfterMs = (error.retryAfter ?? 1) * 1000
        next = { kind: 'loading', previous }
      } else {
        next = { kind: 'error', message: error instanceof Error ? error.message : String(error), previous }
      }
    }
    const isCurrent = this.requests.get(hostId) === request
      && this.connectionFor(hostId) === connection
      && connection.state.sessionGeneration === generation
    if (!isCurrent) return
    this.set(hostId, next)
    if (retryAfterMs !== null) this.retries.set(hostId, setTimeout(() => void this.load(hostId, attempt + 1), retryAfterMs))
  }

  forgetHost(hostId: string): void {
    clearTimeout(this.retries.get(hostId))
    this.retries.delete(hostId)
    this.hosts.delete(hostId)
    this.remerge()
  }

  private set(hostId: string, state: HostThreadsState): void {
    this.hosts.set(hostId, state)
    this.remerge()
  }

  private remerge(): void {
    const threads: SolusThreadShell[] = []
    const archived: SolusThreadShell[] = []
    const projects: SolusProjectShell[] = []
    const children = new Map<string, SolusThreadShell>()
    for (const state of this.hosts.values()) {
      const value = state.kind === 'loaded' ? state.value : state.kind === 'idle' ? null : state.previous
      if (!value) continue
      threads.push(...value.threads)
      archived.push(...(value.archived ?? []))
      projects.push(...value.projects)
      for (const child of value.children ?? []) children.set(child.key, child)
    }
    this.children = children
    threads.sort((a, b) => b.record.lastActivityAt - a.record.lastActivityAt)
    archived.sort((a, b) => b.record.lastActivityAt - a.record.lastActivityAt)
    projects.sort((a, b) => a.project.folderName.localeCompare(b.project.folderName))
    this.merged = { threads, archived, projects }
    this.changes.notify()
  }
}
