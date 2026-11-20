import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { ListMySessionsResponse, SessionRepositoryFacts } from '@solus/contracts/session-repositories'
import type { SessionRecord } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { isSolusApiId } from '@solus/contracts/uplink'
import { keepEqual } from '@solus/client-core/keep-equal'
import type { SessionCloudHead } from '@solus/client-core/session-heads'
import type { ListedSession, SessionListHosts } from './session-list.store.svelte'

type CloudEntry = ListMySessionsResponse['items'][number]

/** A session only the cloud lists, as its row draws it. */
export interface CloudSessionRow {
  sessionId: string
  /** The Solus API connection that listed it. */
  apiServerId: string
  title: string | null
  provider: SessionRecord['provider']
  model: string | null
  repositoryKey: string | null
  branch: string | null
  lastActivityAt: number
}

/**
 * What the cloud knows of this person's sessions
 * (docs/plans/portable-sessions-cloud.md §5.4, §5.5): the four facts of each
 * session, and the sessions it lists that no connected host may have. The
 * facts come from the Solus API records, from `listMySessions`, and from
 * `session.headChanged`. An event writes one property of one session: each
 * value is a `$state` object changed in place, so no list is built again.
 * Everything a Solus API connection gave goes when that connection goes
 * (sign-out).
 */
export class CloudSessions {
  /** The four facts of each session, by session id. */
  private factsBySession = new SvelteMap<string, SessionRepositoryFacts>()
  /** The Solus API connection each session's facts came from. */
  private sourceBySession = new Map<string, string>()
  /** The sessions `listMySessions` answered, by session id. */
  private rowsBySession = new SvelteMap<string, CloudSessionRow>()
  private watchedServerIds = new Set<string>()
  /** The Solus API connections whose list answered, or failed to answer. */
  private listedServerIds = new SvelteSet<string>()
  /** One list read at a time for each Solus API connection. */
  private loads = new Map<string, Promise<void>>()
  /** The list row of each cloud-only session, kept while its row and host do not change. */
  private listedByRow = new WeakMap<CloudSessionRow, ListedSession>()

  constructor(
    private readonly hosts: Pick<SessionListHosts, 'connectedRunnerFor' | 'savedRunnerFor'>,
    /** Whether a connected home lists the session: its row is then the home's, not the cloud's. */
    private readonly isListedByHost: (sessionId: string) => boolean,
  ) {}

  /** The cloud's facts of a session, or undefined when the cloud has none here. */
  factsFor(sessionId: string): SessionRepositoryFacts | undefined {
    return this.factsBySession.get(sessionId)
  }

  /** The Solus API connection a session's facts came from: the one that reads its cloud copy. */
  apiServerFor(sessionId: string): string | null {
    return this.factsBySession.has(sessionId) ? this.sourceBySession.get(sessionId) ?? null : null
  }

  /** Whether a Solus API list answered. Before it, a session the cloud does not
   *  name may still be in it. */
  isListed(): boolean {
    return this.listedServerIds.size > 0
  }

  /** The model the cloud card names for a session. */
  modelOf(sessionId: string): string | undefined {
    return this.rowsBySession.get(sessionId)?.model ?? undefined
  }

  /** What the cloud knows of a session, with its last run host as this client names it. */
  headFor(sessionId: string): SessionCloudHead | null {
    const facts = this.factsBySession.get(sessionId)
    if (!facts) return null
    return { ...facts, lastRunServerId: facts.lastRunHostId ? this.savedRunnerFor(facts.lastRunHostId) : null }
  }

  /** The connected host that runs a turn of this session now. A running host
   *  this client cannot reach is not counted: its fact can be stale (design §5.4). */
  runningServerFor(sessionId: string): string | null {
    const runningHostId = this.factsBySession.get(sessionId)?.runningHostId
    return runningHostId ? this.hosts.connectedRunnerFor(runningHostId) : null
  }

  /** The cloud-only row of one session; see `listedRows`. */
  listed(sessionId: string): ListedSession | undefined {
    const row = this.rowsBySession.get(sessionId)
    return (row && this.listedRow(row)) ?? undefined
  }

  /** The rows of the sessions only the cloud lists. */
  listedRows(): ListedSession[] {
    const listed: ListedSession[] = []
    for (const row of this.rowsBySession.values()) {
      const entry = this.listedRow(row)
      if (entry) listed.push(entry)
    }
    return listed
  }

  /**
   * The row of a session only the cloud lists, or null when a connected host
   * has it: a home lists it, or the host that ran its last turn is connected
   * and does not list it (it was archived there). It opens on the host that
   * ran its last turn when this client keeps that host.
   */
  private listedRow(row: CloudSessionRow): ListedSession | null {
    if (this.isListedByHost(row.sessionId)) return null
    const lastRunHostId = this.factsBySession.get(row.sessionId)?.lastRunHostId
    if (lastRunHostId && this.hosts.connectedRunnerFor(lastRunHostId)) return null
    const serverId = (lastRunHostId ? this.savedRunnerFor(lastRunHostId) : null) ?? row.apiServerId
    const known = this.listedByRow.get(row)
    if (known?.serverId === serverId) return known
    const listed: ListedSession = {
      serverId,
      homeServerId: row.apiServerId,
      runnerOffline: true,
      sessionId: row.sessionId,
      organizationId: 'local',
      title: row.title,
      projectPath: row.repositoryKey,
      createdAt: row.lastActivityAt,
      lastActivityAt: row.lastActivityAt,
      status: 'idle',
      branch: row.branch,
      ownerKey: '',
      opensWith: { provider: row.provider, projectPath: '', cwd: '' },
      cloudOnly: true,
      repositoryKey: row.repositoryKey,
    }
    this.listedByRow.set(row, listed)
    return listed
  }

  private savedRunnerFor(hostId: string): string | null {
    return (this.hosts.savedRunnerFor ?? this.hosts.connectedRunnerFor)(hostId)
  }

  /** Keep the facts a Solus API answered for a session. Equal facts change nothing. */
  write(serverId: string, sessionId: string, facts: SessionRepositoryFacts): void {
    this.sourceBySession.set(sessionId, serverId)
    const known = this.factsBySession.get(sessionId)
    if (!known) {
      const created = $state({ head: facts.head, syncedTurn: facts.syncedTurn, lastRunHostId: facts.lastRunHostId, runningHostId: facts.runningHostId })
      this.factsBySession.set(sessionId, created)
      return
    }
    if (known.head !== facts.head) known.head = facts.head
    if (known.syncedTurn !== facts.syncedTurn) known.syncedTurn = facts.syncedTurn
    if (known.lastRunHostId !== facts.lastRunHostId) known.lastRunHostId = facts.lastRunHostId
    if (known.runningHostId !== facts.runningHostId) known.runningHostId = facts.runningHostId
  }

  /** A Solus API record carries the facts when its session has a cloud row. */
  writeRecord(serverId: string, record: SessionRecord): void {
    if (record.syncedTurn === undefined) return
    this.write(serverId, record.sessionId, {
      head: record.head ?? null,
      syncedTurn: record.syncedTurn,
      lastRunHostId: record.lastRunHostId ?? null,
      runningHostId: record.runningHostId ?? null,
    })
  }

  /** Read this person's sessions in the cloud from one Solus API connection. A
   *  failed read keeps what it answered last time. */
  load(serverId: string): Promise<void> {
    if (!isSolusApiId(serverId)) return Promise.resolve()
    this.watch(serverId)
    const running = this.loads.get(serverId)
    if (running) return running
    const load = this.read(serverId).finally(() => this.loads.delete(serverId))
    this.loads.set(serverId, load)
    return load
  }

  private async read(serverId: string): Promise<void> {
    const api = serverConnections.apiFor(serverId)
    // An older Solus API has no such route; that is "no cloud entries", not an error.
    const items = await Promise.resolve().then(() => api.sessionCloudList()).catch(() => null)
    if (serverConnections.apiFor(serverId) !== api) return
    this.listedServerIds.add(serverId)
    if (!items) return
    const answered = new Set<string>()
    for (const item of items) {
      answered.add(item.sessionId)
      this.write(serverId, item.sessionId, item)
      this.writeRow(serverId, item)
    }
    for (const [sessionId, row] of this.rowsBySession) {
      if (row.apiServerId === serverId && !answered.has(sessionId)) this.rowsBySession.delete(sessionId)
    }
  }

  private writeRow(serverId: string, item: CloudEntry): void {
    const row: CloudSessionRow = {
      sessionId: item.sessionId,
      apiServerId: serverId,
      title: item.title,
      provider: item.provider,
      model: item.model,
      repositoryKey: item.repositoryKey,
      branch: item.branch,
      lastActivityAt: item.lastActivityAt,
    }
    // A list read again with no change keeps the row object, so its sidebar row does not draw again.
    this.rowsBySession.set(item.sessionId, keepEqual(row, this.rowsBySession.get(item.sessionId) ?? row))
  }

  /** `session.headChanged` writes the facts in place. A session this client has
   *  no row for yet is listed again, since the event has no card. */
  private watch(serverId: string): void {
    if (this.watchedServerIds.has(serverId)) return
    this.watchedServerIds.add(serverId)
    serverConnections.eventsFor(serverId).subscribe('session.headChanged', ({ sessionId, ...facts }) => {
      const isKnown = this.factsBySession.has(sessionId)
      this.write(serverId, sessionId, facts)
      if (!isKnown && facts.head) void this.load(serverId)
    })
  }

  /** A Solus API connection went (sign-out, or another organization): what it gave goes too. */
  forget(serverId: string): void {
    if (!isSolusApiId(serverId)) return
    this.listedServerIds.delete(serverId)
    for (const [sessionId, source] of this.sourceBySession) {
      if (source !== serverId) continue
      this.sourceBySession.delete(sessionId)
      this.factsBySession.delete(sessionId)
    }
    for (const [sessionId, row] of this.rowsBySession) {
      if (row.apiServerId === serverId) this.rowsBySession.delete(sessionId)
    }
  }
}
