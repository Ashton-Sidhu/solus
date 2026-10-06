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
  readonly projects: readonly SolusProjectShell[]
  /** The host's first index sweep is still running: the list is not final. */
  readonly indexing: boolean
}

/** Every readable host's threads and projects, as one sorted snapshot. */
interface MergedThreads {
  readonly threads: readonly SolusThreadShell[]
  readonly projects: readonly SolusProjectShell[]
}

export function threadKey(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`
}

/** How many sessions a host is asked for; the home list pages locally. */
const SESSION_LIMIT = 500

const IDLE = { kind: 'idle' } as const

export class ThreadDirectory {
  readonly changes = new Listeners()
  private readonly hosts = new Map<string, HostThreadsState>()
  private readonly requests = new Map<string, number>()
  private nextRequest = 0
  /** A stable snapshot, replaced only when a host's state changes. */
  private merged: MergedThreads = { threads: [], projects: [] }
  private children = new Map<string, SolusThreadShell>()

  constructor(
    private readonly registry: HostRegistry,
    private readonly connectionFor: (hostId: string) => HostConnection | null,
  ) {}

  stateOf = (hostId: string): HostThreadsState => this.hosts.get(hostId) ?? IDLE

  /** Every readable host's sessions, newest activity first. Delegated child
   *  sessions open from their parent's transcript, not the list. */
  threads = (): readonly SolusThreadShell[] => this.merged.threads

  projects = (): readonly SolusProjectShell[] => this.merged.projects

  /** A listed session, or a child session its parent's agent card opens. */
  thread = (hostId: string, sessionId: string): SolusThreadShell | null =>
    this.merged.threads.find((thread) => thread.key === threadKey(hostId, sessionId))
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

  async load(hostId: string): Promise<void> {
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
    try {
      const [list, projects] = await Promise.all([
        connection.api.sessionRecordList({ includeWorktrees: true, limit: SESSION_LIMIT }),
        connection.api.listProjects(),
      ])
      const shells = list.records.map((record) => ({ key: threadKey(hostId, record.sessionId), hostId, hostLabel: host.label, record }))
      next = {
        kind: 'loaded',
        value: {
          threads: shells.filter((shell) => shell.record.parentSessionId === null),
          children: shells.filter((shell) => shell.record.parentSessionId !== null),
          projects: projects.map((project) => ({ key: `${hostId}\u0000${project.path}`, hostId, hostLabel: host.label, project })),
          indexing: list.indexing,
        },
      }
    } catch (error) {
      next = { kind: 'error', message: error instanceof Error ? error.message : String(error), previous }
    }
    const isCurrent = this.requests.get(hostId) === request
      && this.connectionFor(hostId) === connection
      && connection.state.sessionGeneration === generation
    if (isCurrent) this.set(hostId, next)
  }

  forgetHost(hostId: string): void {
    this.hosts.delete(hostId)
    this.remerge()
  }

  private set(hostId: string, state: HostThreadsState): void {
    this.hosts.set(hostId, state)
    this.remerge()
  }

  private remerge(): void {
    const threads: SolusThreadShell[] = []
    const projects: SolusProjectShell[] = []
    const children = new Map<string, SolusThreadShell>()
    for (const state of this.hosts.values()) {
      const value = state.kind === 'loaded' ? state.value : state.kind === 'idle' ? null : state.previous
      if (!value) continue
      threads.push(...value.threads)
      projects.push(...value.projects)
      for (const child of value.children ?? []) children.set(child.key, child)
    }
    this.children = children
    threads.sort((a, b) => b.record.lastActivityAt - a.record.lastActivityAt)
    projects.sort((a, b) => a.project.folderName.localeCompare(b.project.folderName))
    this.merged = { threads, projects }
    this.changes.notify()
  }
}
