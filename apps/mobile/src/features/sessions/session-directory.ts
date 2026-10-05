import type { ProjectEntry, SessionRecord } from '@solus/contracts/types'
import { isChat } from '@solus/contracts/chat'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'

/**
 * Projects and sessions of one host, read through the host's own RPC and
 * record API (plan 017 stage 2). Every entry is keyed by host: one session id
 * on two hosts is two sessions. A read that started before the host's server
 * session changed, or before a newer read of the same list, is dropped.
 */

export type ListState<T> =
  | { kind: 'idle' }
  | { kind: 'loading'; previous: T[] | null }
  | { kind: 'loaded'; items: T[] }
  | { kind: 'error'; message: string; previous: T[] | null }

const IDLE = { kind: 'idle' } as const

export function listKey(hostId: string, projectPath?: string): string {
  return projectPath === undefined ? hostId : `${hostId}\u0000${projectPath}`
}

export class SessionDirectory {
  private readonly projects = new Map<string, ListState<ProjectEntry>>()
  private readonly sessions = new Map<string, ListState<SessionRecord>>()
  private readonly requests = new Map<string, number>()
  private nextRequest = 0
  readonly changes = new Listeners()

  constructor(private readonly connectionFor: (hostId: string) => HostConnection | null) {}

  projectsOf = (hostId: string): ListState<ProjectEntry> => this.projects.get(listKey(hostId)) ?? IDLE

  sessionsOf = (hostId: string, projectPath: string): ListState<SessionRecord> =>
    this.sessions.get(listKey(hostId, projectPath)) ?? IDLE

  async loadProjects(hostId: string): Promise<void> {
    await this.load(this.projects, listKey(hostId), hostId, async (connection) => {
      const projects = await connection.api.listProjects()
      return [...projects].sort((a, b) => a.folderName.localeCompare(b.folderName))
    })
  }

  /** A project's sessions, or the host's chats when `projectPath` is a chat. */
  async loadSessions(hostId: string, projectPath: string): Promise<void> {
    await this.load(this.sessions, listKey(hostId, projectPath), hostId, async (connection) => {
      const list = await connection.api.sessionRecordList(isChat(projectPath) ? { chats: true } : { projectPath, includeWorktrees: true })
      // Delegated child sessions open from their parent's transcript, not the list.
      return list.records
        .filter((record) => record.parentSessionId === null)
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    })
  }

  /** Forgetting a host drops its lists. */
  forgetHost(hostId: string): void {
    for (const map of [this.projects, this.sessions]) {
      for (const key of Array.from(map.keys())) if (key === hostId || key.startsWith(`${hostId}\u0000`)) map.delete(key)
    }
    this.changes.notify()
  }

  private async load<T>(
    map: Map<string, ListState<T>>,
    key: string,
    hostId: string,
    read: (connection: HostConnection) => Promise<T[]>,
  ): Promise<void> {
    const connection = this.connectionFor(hostId)
    const current = map.get(key)
    const previous = current?.kind === 'loaded' ? current.items : current?.kind === 'loading' || current?.kind === 'error' ? current.previous : null
    if (!connection) {
      map.set(key, { kind: 'error', message: 'This host cannot be reached now.', previous })
      this.changes.notify()
      return
    }
    const request = ++this.nextRequest
    const generation = connection.state.sessionGeneration
    this.requests.set(key, request)
    map.set(key, { kind: 'loading', previous })
    this.changes.notify()
    try {
      const items = await read(connection)
      if (!this.isCurrent(key, request, connection, generation)) return
      map.set(key, { kind: 'loaded', items })
    } catch (error) {
      if (!this.isCurrent(key, request, connection, generation)) return
      map.set(key, { kind: 'error', message: error instanceof Error ? error.message : String(error), previous })
    }
    this.changes.notify()
  }

  private isCurrent(key: string, request: number, connection: HostConnection, generation: number): boolean {
    return this.requests.get(key) === request
      && this.connectionFor(connection.hostId) === connection
      && connection.state.sessionGeneration === generation
  }
}
