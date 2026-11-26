import type { ListMySessionsResponse, SessionRepositoryFacts } from '@solus/contracts/session-repositories'
import type { SessionRecord } from '@solus/contracts/types'
import { organizationIdOfSolusApiId } from '@solus/contracts/uplink'
import type { SessionCloudHead } from '@solus/client-core/session-heads'
import { readsSessionsFromSolusApi } from '@solus/client-core/session-home'
import { keepEqual } from '@solus/client-core/keep-equal'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'

type CloudEntry = ListMySessionsResponse['items'][number]

/** The answer of the organization's session list when the Solus API is not a source of its sessions. */
const NO_ORGANIZATION_RECORDS: { records: readonly SessionRecord[] } = { records: [] }

/** A session the cloud lists, as a thread record: the card, and the four facts as plain properties.
 *  A session with no session repository has no head and no turn count. */
export type CloudSessionRecord = SessionRecord & SessionRepositoryFacts

export interface CloudSessionsDeps {
  /** The saved host that an account host id names, connected or not; null when this phone keeps none. */
  savedHostFor(accountHostId: string): string | null
  /** The host is connected now. */
  isReady(hostId: string): boolean
  /** Every host this phone keeps, in the order it shows them. */
  hostIds(): readonly string[]
  /**
   * Whether an organization saves the conversations of its sessions in Solus
   * Cloud, as the account directory says (`DirectoryWorkspace.sessionCloudSync`).
   * Absent: it does.
   */
  savesSessionsToCloud?(organizationId: string): boolean
}

/** A session only the cloud lists, and the host its thread opens on. */
export interface CloudOnlySession {
  hostId: string
  /** The host that ran the session is one this phone keeps. */
  isLastRunHost: boolean
  record: CloudSessionRecord
}

/**
 * What the cloud knows of the sessions this person can read, on the phone
 * (docs/plans/portable-sessions-cloud.md §5.4, §5.5). It reads two lists from
 * the Solus API connection of the organization this device works in:
 * `listMySessions` (the person's own sessions that have a session repository)
 * and the session list of the organization (its published sessions, whose rows
 * the transcript mirror holds). It reads them again on each reconnect, and
 * writes each `session.headChanged` into the session's record in place.
 * Everything goes when the connection goes (sign-out, another organization).
 *
 * An organization that does not save its sessions to Solus Cloud keeps their
 * conversations on their hosts (client-core `session-home.ts`). Its Solus API
 * is then not a source of its sessions: the session list of the organization
 * is not read and no published record stays here. The machines list these
 * sessions. The person's own entries of `listMySessions` stay.
 */
export class CloudSessions {
  readonly changes = new Listeners()
  private readonly records = new Map<string, CloudSessionRecord>()
  private followed: HostConnection | null = null
  private stopFollowing: Array<() => void> = []
  /** Bumps on each `follow`, so a list answer from an older connection is dropped. */
  private generation = 0
  private loading: Promise<void> | null = null
  /** The Solus API followed now is a source of its organization's sessions (`readsSessionsFromSolusApi`). */
  private readsOrganization = true

  constructor(private readonly deps: CloudSessionsDeps) {}

  /** The Solus API connection that gave the cloud facts now; null when none. */
  get connectionId(): string | null {
    return this.followed?.hostId ?? null
  }

  /** The Solus API connection followed now: the cloud's history and diffs are read through it. */
  get connection(): HostConnection | null {
    return this.followed
  }

  /** How many sessions the cloud lists. */
  get recordCount(): number {
    return this.records.size
  }

  /** The cloud's record of a session; undefined when the cloud lists none. */
  recordFor(sessionId: string): CloudSessionRecord | undefined {
    return this.records.get(sessionId)
  }

  /**
   * Solus Cloud has no copy of this session to read: the organization of the
   * Solus API followed now keeps its sessions on their hosts, and the session
   * is not one of the person's own cloud entries.
   */
  isKeptOnHost = (sessionId: string): boolean =>
    this.followed !== null && !this.readsOrganization && !this.records.has(sessionId)

  /** What the cloud knows of a session, with its last run host as this phone names it. */
  headFor = (sessionId: string): SessionCloudHead | null => {
    const record = this.records.get(sessionId)
    if (!record) return null
    return {
      head: record.head,
      syncedTurn: record.syncedTurn,
      lastRunHostId: record.lastRunHostId,
      runningHostId: record.runningHostId,
      lastRunServerId: record.lastRunHostId ? this.deps.savedHostFor(record.lastRunHostId) : null,
    }
  }

  /** The connected host that runs a turn of this session now. A running host
   *  this phone cannot reach is not counted: its fact can be stale (design §5.4). */
  runningHostFor(sessionId: string): string | null {
    const runningHostId = this.records.get(sessionId)?.runningHostId
    const hostId = runningHostId ? this.deps.savedHostFor(runningHostId) : null
    return hostId && this.deps.isReady(hostId) ? hostId : null
  }

  /**
   * The sessions only the cloud lists (design §5.5). A session that a host
   * lists has no cloud row: the host's record wins. Nor has one whose last run
   * host is connected and does not list it, because that host archived it.
   * The thread opens on the host that ran the last turn (for a session with no
   * session repository, the host that ran it) when this phone keeps it, so its
   * state says that host is offline; else on a connected host, which syncs it
   * from the cloud. With no host at all there is no row: the list already asks
   * for a host.
   */
  onlyInCloud(isListedByHost: (sessionId: string) => boolean): CloudOnlySession[] {
    const sessions: CloudOnlySession[] = []
    if (this.records.size === 0) return sessions
    const hostIds = this.deps.hostIds()
    const fallbackHostId = hostIds.find((hostId) => this.deps.isReady(hostId)) ?? hostIds[0]
    for (const record of this.records.values()) {
      if (isListedByHost(record.sessionId)) continue
      const ranOnHostId = record.lastRunHostId ?? record.runnerHostId
      const lastRunHostId = ranOnHostId ? this.deps.savedHostFor(ranOnHostId) : null
      if (lastRunHostId && this.deps.isReady(lastRunHostId)) continue
      const hostId = lastRunHostId ?? fallbackHostId
      if (hostId) sessions.push({ hostId, isLastRunHost: hostId === lastRunHostId, record })
    }
    return sessions
  }

  /**
   * Follow one Solus API connection, or none. A new connection drops what the
   * old one gave, then lists again when it connects, and on each reconnect, so
   * a fact missed while away is read again.
   */
  follow(connection: HostConnection | null): void {
    if (connection === this.followed) return
    for (const stop of this.stopFollowing) stop()
    this.stopFollowing = []
    this.generation += 1
    this.loading = null
    this.followed = connection
    this.readsOrganization = this.readsOrganizationNow()
    this.records.clear()
    // Also with no record: the readers of `connection` hear that it changed.
    this.changes.notify()
    if (!connection) return
    this.stopFollowing.push(
      connection.events.subscribe('session.headChanged', ({ sessionId, ...facts }) => this.headChanged(sessionId, facts)),
      connection.onAccepted(() => void this.load()),
    )
    if (connection.state.readiness === 'ready') void this.load()
  }

  /**
   * The account directory changed. When its answer to "does this organization
   * save its sessions to Solus Cloud" is a new one, the published records go
   * at once if the answer is no, and the lists are read again. A list answer
   * from before the change is dropped, as one from an older connection is.
   */
  followSessionSource(): void {
    const readsOrganization = this.readsOrganizationNow()
    if (readsOrganization === this.readsOrganization) return
    this.readsOrganization = readsOrganization
    this.generation += 1
    this.loading = null
    if (!readsOrganization) this.dropPublishedRecords()
    // Also with no record dropped: the readers of `isKeptOnHost` hear that it changed.
    this.changes.notify()
    if (this.followed?.state.readiness === 'ready') void this.load()
  }

  /** Read the sessions the cloud lists for this person. A list that cannot be read keeps what it answered last time. */
  load(): Promise<void> {
    if (this.loading) return this.loading
    // A read that `follow` or `followSessionSource` replaced must not clear the read that came after it.
    const loading: Promise<void> = this.read().finally(() => { if (this.loading === loading) this.loading = null })
    this.loading = loading
    return loading
  }

  /** Whether the organization of the followed Solus API saves its sessions to Solus Cloud now. */
  private readsOrganizationNow(): boolean {
    const organizationId = this.followed ? organizationIdOfSolusApiId(this.followed.hostId) : null
    return !organizationId || readsSessionsFromSolusApi(organizationId, this.deps)
  }

  private dropPublishedRecords(): void {
    for (const record of this.records.values()) {
      if (record.publication === 'published') this.records.delete(record.sessionId)
    }
  }

  private async read(): Promise<void> {
    const connection = this.followed
    if (!connection) return
    // The directory's answer as it is now: the rule holds also when no one called `followSessionSource`.
    const readsOrganization = this.readsOrganizationNow()
    this.readsOrganization = readsOrganization
    const generation = this.generation
    const [items, organization] = await Promise.all([
      // An older Solus API has no such route; that is "no cloud entries", not an error.
      Promise.resolve().then(() => connection.api.sessionCloudList()).catch(() => null),
      // An organization that keeps its sessions on their hosts: its list is not asked, and it answers no record.
      readsOrganization ? Promise.resolve().then(() => connection.api.sessionRecordList()).catch(() => null) : NO_ORGANIZATION_RECORDS,
    ])
    if (generation !== this.generation || (!items && !organization)) return
    const answered = new Set<string>()
    for (const item of items ?? []) {
      answered.add(item.sessionId)
      this.writeEntry(item)
    }
    for (const record of organization?.records ?? []) {
      if (answered.has(record.sessionId) || record.publication !== 'published') continue
      answered.add(record.sessionId)
      this.writeOrganizationRecord(record)
    }
    for (const record of this.records.values()) {
      const wasListRead = record.publication === 'published' ? organization !== null : items !== null
      if (wasListRead && !answered.has(record.sessionId)) this.records.delete(record.sessionId)
    }
    this.changes.notify()
  }

  /**
   * A published session of the organization's list. The transcript mirror
   * holds its rows, so it needs no session repository to have a record here:
   * without one it has no head and no turn count. An unchanged record keeps
   * its object, so its row does not draw again.
   */
  private writeOrganizationRecord(record: SessionRecord): void {
    const answered: CloudSessionRecord = {
      ...record,
      head: record.head ?? null,
      syncedTurn: record.syncedTurn ?? 0,
      lastRunHostId: record.lastRunHostId ?? null,
      runningHostId: record.runningHostId ?? null,
    }
    const kept = this.records.get(record.sessionId)
    this.records.set(record.sessionId, kept ? keepEqual(answered, kept) : answered)
  }

  /** The event writes the four properties of the record in place. A session
   *  with no record yet is listed again, because the event has no card. */
  private headChanged(sessionId: string, facts: SessionRepositoryFacts): void {
    const record = this.records.get(sessionId)
    if (!record) {
      if (facts.head) void this.load()
      return
    }
    if (writeFacts(record, facts)) this.changes.notify()
  }

  /** A list answer with the same card keeps the record and writes its facts in
   *  place, so its row keeps its object; a new card is a new record, so the row draws again. */
  private writeEntry(item: CloudEntry): void {
    const record = this.records.get(item.sessionId)
    const isSameCard = record !== undefined && record.title === item.title && record.provider === item.provider
      && record.model === item.model && record.projectRemote === item.repositoryKey
      && record.branch === item.branch && record.lastActivityAt === item.lastActivityAt
    if (isSameCard) writeFacts(record, item)
    else this.records.set(item.sessionId, cloudRecord(item))
  }
}

/** Writes the facts that changed; true when one did. */
function writeFacts(record: CloudSessionRecord, facts: SessionRepositoryFacts): boolean {
  let isChanged = false
  if (record.head !== facts.head) { record.head = facts.head; isChanged = true }
  if (record.syncedTurn !== facts.syncedTurn) { record.syncedTurn = facts.syncedTurn; isChanged = true }
  if (record.lastRunHostId !== facts.lastRunHostId) { record.lastRunHostId = facts.lastRunHostId; isChanged = true }
  if (record.runningHostId !== facts.runningHostId) { record.runningHostId = facts.runningHostId; isChanged = true }
  return isChanged
}

/**
 * An entry of `listMySessions` as a thread record. The phone does not know the
 * folder a host keeps the session in, so the record names none: the host that
 * syncs the session restores it in its own folder. These entries are personal
 * (`person:` scope), as desktop decision 6 says.
 */
function cloudRecord(item: CloudEntry): CloudSessionRecord {
  return {
    sessionId: item.sessionId,
    organizationId: 'local',
    publication: 'local',
    ownerKey: '',
    provider: item.provider,
    projectPath: '',
    projectRemote: item.repositoryKey,
    runnerHostId: item.lastRunHostId,
    head: item.head,
    syncedTurn: item.syncedTurn,
    lastRunHostId: item.lastRunHostId,
    runningHostId: item.runningHostId,
    title: item.title,
    customTitle: null,
    status: 'idle',
    model: item.model,
    reasoningEffort: null,
    parentSessionId: null,
    rootSessionId: null,
    createdAt: item.lastActivityAt,
    lastActivityAt: item.lastActivityAt,
    size: 0,
    cwd: null,
    slug: null,
    isWorktree: false,
    branch: item.branch,
    projectRoot: null,
    delegation: null,
    place: null,
    startedBy: null,
    codebaseId: null,
    attachedFolders: [],
  }
}
