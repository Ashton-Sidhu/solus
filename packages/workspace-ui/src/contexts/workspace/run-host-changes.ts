import type { DispatchRepository, PromptOptions, RunLocation, Session, SessionMeta, StatusCardState } from '@solus/contracts/types'
import type { SessionPrepareRequest, SessionPrepareResult } from '@solus/contracts/rpc'
import { serverConnections } from '@solus/client-core/server-connections'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { newestSessionHost, sessionSyncSource, type SessionHostTurn } from '@solus/client-core/session-heads'
import { isSessionSyncCard } from '@solus/client-core/session-sync-card'
import { moveTabToHost, repoKeyForPath, syncRepository, type RunOnWorkspace } from '../../components/servers/run-on'
import { serversStore } from '../connections/servers.store.svelte'
import { sessionListStore } from './session-list.store.svelte'
import { checkoutGit, checkoutPlace, openFolder, pendingClone, runHost, workingPlace } from './run-location'

/** What the run host changes read and call on the workspace. */
export interface RunHostWorkspace extends RunOnWorkspace {
  tabIdForSession(sessionId: string): string | undefined
}

/** The hosts and facts the run host changes use. Replaced in tests. */
export interface RunHostDeps {
  resolveId(serverId: string): string
  hostTurnsFor(sessionId: string): readonly SessionHostTurn[]
  /** Read one session's info from one host; the answer also updates the facts. */
  readMeta(serverId: string, sessionId: string): Promise<SessionMeta | null>
  prepare(serverId: string, request: SessionPrepareRequest): Promise<SessionPrepareResult>
  /** The id a run host knows another host by: its installation id. */
  hostRef(serverId: string): string
  /** The project's repository key, as the host of `location` names it. */
  repoKeyOf(location: RunLocation): string | null
  repository(run: Pick<Session['run'], 'location'>, repoKey: string | null): Promise<DispatchRepository | undefined>
}

const registryDeps: RunHostDeps = {
  resolveId: (serverId) => serverConnections.resolveId(serverId),
  hostTurnsFor: (sessionId) => sessionListStore.hostTurnsFor(sessionId),
  readMeta: (serverId, sessionId) => readSessionMeta(serverId, sessionId),
  prepare: (serverId, request) => serverConnections.apiFor(serverId).sessionPrepare(request),
  hostRef: (serverId) => {
    const host = serversStore.hostFor(serverId)
    return serverConnections.factsFor(serverId).value('serverInfo')?.installationId
      ?? (host && 'installationId' in host ? host.installationId : undefined)
      ?? serverId
  },
  repoKeyOf: (location) => {
    const clone = pendingClone({ location })
    if (clone) return clone.repoKey
    const folder = checkoutPlace({ location })
    return repoKeyForPath(serversStore.projectIdentitiesFor(folder.serverId), checkoutGit({ location })?.repoRoot ?? folder.path)
  },
  repository: syncRepository,
}

/** The session a tab syncs: a pending fork syncs its source (plan §10, decision 14). */
function syncedSessionId(session: Session): string {
  return session.forked && session.forkSourceSessionId ? session.forkSourceSessionId : session.id
}

/**
 * The one owner of a run host change for a started session or a pending fork
 * (docs/plans/portable-sessions.md §10). A pick moves the tab at once and
 * starts a sync on the new host in the background; nothing here blocks typing
 * or the send. A prompt sent meanwhile carries the newest head the client
 * knows, and the host holds it until its sync ends.
 */
export class RunHostChanges {
  /** Per session, where its tab was on a host that has the session, until the
   *  new run host is current. Tab persistence saves this one, so a reload
   *  never restores a tab on a host that has no copy of its conversation. */
  private readonly unconfirmed = new Map<string, RunLocation>()

  constructor(
    private readonly workspace: RunHostWorkspace,
    /** Read Git and the checkout of the tab's new working place again. */
    private readonly refreshRunEnvironment: (tabId: string) => void,
    private readonly deps: RunHostDeps = registryDeps,
  ) {}

  /** A person chose another host in Run on for a started session. */
  change(tabId: string, location: RunLocation): boolean {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return false
    const previous = session.run.location
    const repoKey = this.deps.repoKeyOf(previous)
    if (!moveTabToHost({ workspace: this.workspace, tabId, location }).ok) return false
    const known = this.unconfirmed.get(session.id)
    // Back on the host it came from: that host has the session already. A
    // pending fork has no conversation on any host yet, so it keeps its pick.
    if (known && runHost({ location: known }) === runHost(session.run)) this.unconfirmed.delete(session.id)
    else if (!known && !session.forked) this.unconfirmed.set(session.id, previous)
    void this.prepare(tabId, { repoKey, previousServerId: runHost({ location: previous }) })
    return true
  }

  /** The tab opened a session whose run host may be behind: get it ready
   *  before the person sends (plan §10). Uses only facts already read. */
  opened(tabId: string): void {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    const runServerId = this.deps.resolveId(runHost(session.run))
    if (sessionSyncSource(this.deps.hostTurnsFor(syncedSessionId(session)), runServerId)) void this.prepare(tabId)
  }

  /**
   * Start a sync on the tab's run host. The newest host is read once first,
   * because its head changes with each turn it runs and this client learns the
   * new head only by a read.
   */
  async prepare(tabId: string, opts: { repoKey?: string | null; previousServerId?: string } = {}): Promise<void> {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    const sessionId = syncedSessionId(session)
    const location = session.run.location
    const runServerId = this.deps.resolveId(runHost(session.run))
    const newest = newestSessionHost(this.deps.hostTurnsFor(sessionId), runServerId)?.serverId
      ?? (opts.previousServerId ? this.deps.resolveId(opts.previousServerId) : null)
    if (newest && newest !== runServerId) await this.deps.readMeta(newest, sessionId).catch(() => null)
    const source = sessionSyncSource(this.deps.hostTurnsFor(sessionId), runServerId)
    const isStale = () => this.workspace.sessionFor(tabId) !== session || session.run.location !== location
    if (isStale()) return
    if (!source) {
      // The run host has the newest turn this client knows: nothing to sync,
      // but the tab works where that host keeps the session.
      if (session.id === sessionId) void this.adoptRunHost(tabId, runServerId)
      return
    }
    const repository = await this.deps.repository(session.run, opts.repoKey ?? this.deps.repoKeyOf(location))
    if (isStale()) return
    const request: SessionPrepareRequest = {
      sessionId,
      knownHead: source.knownHead,
      sourceHostId: this.deps.hostRef(source.sourceServerId),
    }
    if (repository) request.repository = repository
    try {
      const result = await this.deps.prepare(runServerId, request)
      if (isStale()) return
      // A fork's source is synced for the fork's first prompt; the fork has no
      // record of its own there yet, so there is nothing more to adopt.
      if (result.state === 'current' && session.id === sessionId) void this.adoptRunHost(tabId, runServerId)
    } catch (error) {
      // An older host has no prepare; the prompt still carries the head and syncs there.
      console.warn('[Solus] Session prepare failed; the next prompt syncs instead.', error)
    }
  }

  /** The run host's sync card for a session changed. */
  syncCardChanged(serverId: string, sessionId: string, card: StatusCardState): void {
    if (!isSessionSyncCard(card, sessionId) || card.status !== 'done') return
    const tabId = this.workspace.tabIdForSession(sessionId)
    const session = tabId ? this.workspace.sessionFor(tabId) : undefined
    if (!tabId || !session || this.deps.resolveId(runHost(session.run)) !== serverId) return
    void this.adoptRunHost(tabId, serverId)
  }

  /**
   * The run host is current: the tab works where that host restored the
   * session, which a read of its session info names, and persistence may keep
   * the new host.
   */
  private async adoptRunHost(tabId: string, serverId: string): Promise<void> {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    this.confirm(session.id)
    const meta = await this.deps.readMeta(serverId, session.id).catch(() => null)
    if (!meta?.cwd || this.workspace.sessionFor(tabId) !== session) return
    if (this.deps.resolveId(runHost(session.run)) !== serverId || session.status !== 'idle' && session.status !== 'completed') return
    if (workingPlace(session.run).path === meta.cwd) return
    session.run.location = openFolder(session.run.location, { serverId: runHost(session.run), path: meta.cwd }, { keepProject: true })
    this.refreshRunEnvironment(tabId)
  }

  /** A prompt went to the run host, or it is current: the session continues there. */
  confirm(sessionId: string): void {
    this.unconfirmed.delete(sessionId)
  }

  /** Where tab persistence keeps a session's tab. */
  persistedLocation(session: Pick<Session, 'id' | 'run'>): RunLocation {
    return this.unconfirmed.get(session.id) ?? session.run.location
  }

  /**
   * What a prompt to the tab's run host carries (plan §7.1): the newest head
   * and the host that has it, when another host has a newer turn. A pending
   * fork that runs on another host names its source session; the head and
   * host are the source's. Built from facts already read: no request.
   */
  promptFields(session: Session): Pick<PromptOptions, 'knownHead' | 'sourceHostId' | 'forkSourceSessionId'> {
    const sessionId = syncedSessionId(session)
    const source = sessionSyncSource(this.deps.hostTurnsFor(sessionId), this.deps.resolveId(runHost(session.run)))
    if (!source) return {}
    const fields: Pick<PromptOptions, 'knownHead' | 'sourceHostId' | 'forkSourceSessionId'> = {
      knownHead: source.knownHead,
      sourceHostId: this.deps.hostRef(source.sourceServerId),
    }
    if (sessionId !== session.id) fields.forkSourceSessionId = sessionId
    return fields
  }
}
