import type { DispatchRepository, PromptOptions, RunLocation, Session, SessionMeta, StatusCardState } from '@solus/contracts/types'
import type { SessionPrepareRequest, SessionPrepareResult } from '@solus/contracts/rpc'
import { serverConnections } from '@solus/client-core/server-connections'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { newestSessionHost, sessionSyncOrigin, type SessionCloudHead, type SessionHostTurn, type SessionSyncOrigin } from '@solus/client-core/session-heads'
import { isSessionSyncCard } from '@solus/client-core/session-sync-card'
import { moveTabToHost, repoKeyForPath, syncRepository, type RunOnWorkspace } from '../../components/servers/run-on'
import { serversStore } from '../connections/servers.store.svelte'
import { sessionListStore } from './session-list.store.svelte'
import { checkoutGit, checkoutPlace, openFolder, pendingClone, runHost, workingPlace } from './run-location'

/** What the run host changes read and call on the workspace. */
export interface RunHostWorkspace extends RunOnWorkspace {
  tabIdForSession(sessionId: string): string | undefined
  /** Loads a session's conversation into a tab that shows none of it yet. */
  opening?: { resumeSession(meta: SessionMeta, opts: { intoTabId: string }): Promise<string> }
  /** The cloud copy a tab shows while no host shows its session (Phase 5B). */
  cloudTranscripts?: { shows(sessionId: string): boolean; release(sessionId: string): void }
}

/** The hosts and facts the run host changes use. Replaced in tests. */
export interface RunHostDeps {
  resolveId(serverId: string): string
  hostTurnsFor(sessionId: string): readonly SessionHostTurn[]
  /** What the cloud knows of a session; null when signed out or not in the cloud. */
  cloudHeadFor(sessionId: string): SessionCloudHead | null
  /** The connected host that runs a turn of this session now, as the cloud says. */
  runningServerFor(sessionId: string): string | null
  /** The repository key a cloud-only session's card names. */
  cloudRepositoryKeyOf(sessionId: string): string | null
  /** The run host refused this session's prompts after its push, or uses the newer copy now. */
  notePushRefused(serverId: string, sessionId: string, isRefused: boolean): void
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
  cloudHeadFor: (sessionId) => sessionListStore.cloud.headFor(sessionId),
  runningServerFor: (sessionId) => sessionListStore.cloud.runningServerFor(sessionId),
  cloudRepositoryKeyOf: (sessionId) => sessionListStore.listed(sessionId)?.repositoryKey ?? null,
  notePushRefused: (serverId, sessionId, isRefused) => sessionListStore.notePushRefused(serverId, sessionId, isRefused),
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

/** A started session that shows no conversation yet: it opened from the cloud
 *  with no host that has it (portable-sessions-cloud §5.5). */
function showsNoConversation(session: Session): boolean {
  return !!session.agentSessionId && !session.forked && session.messages.length === 0 && !session.loadingHistory
    && (session.status === 'idle' || session.status === 'completed')
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
  /** Sessions whose conversation is read again when the run host is current. */
  private readonly reloadsConversation = new Set<string>()

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
    if (this.originFor(session)) void this.prepare(tabId)
  }

  /** A host is ready again: a conversation on it that shows nothing yet loads now. */
  hostReady(serverId: string): void {
    for (const tabId of this.workspace.tabOrder) {
      const session = this.workspace.sessionFor(tabId)
      if (session && this.deps.resolveId(runHost(session.run)) === serverId && this.awaitsRunHost(session)) void this.prepare(tabId)
    }
  }

  /** The tab shows no conversation from a host: nothing, or the cloud copy. */
  private awaitsRunHost(session: Session): boolean {
    return showsNoConversation(session) || !!this.workspace.cloudTranscripts?.shows(session.id)
  }

  /** "Show it" on a cloud copy: the run host has the session now, so its conversation takes the copy's place. */
  showRunHostConversation(tabId: string): void {
    const session = this.workspace.sessionFor(tabId)
    if (session) void this.adoptRunHost(tabId, this.deps.resolveId(runHost(session.run)))
  }

  /** Where the tab's run host syncs its session from (plan §7.1, with the cloud). */
  private originFor(session: Session): SessionSyncOrigin | null {
    const sessionId = syncedSessionId(session)
    return sessionSyncOrigin(this.deps.hostTurnsFor(sessionId), this.deps.resolveId(runHost(session.run)), this.deps.cloudHeadFor(sessionId))
  }

  /** The id the run host finds a source host by. */
  private sourceRef(origin: SessionSyncOrigin): string | undefined {
    return origin.sourceHostId ?? (origin.sourceServerId ? this.deps.hostRef(origin.sourceServerId) : undefined)
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
    // The cloud's head arrives by event; a host's head only by a read.
    if (newest && newest !== runServerId) await this.deps.readMeta(newest, sessionId).catch(() => null)
    const source = this.originFor(session)
    const isStale = () => this.workspace.sessionFor(tabId) !== session || session.run.location !== location
    if (isStale()) return
    if (!source) {
      // The run host has the newest turn this client knows: nothing to sync,
      // but the tab works where that host keeps the session.
      if (session.id === sessionId) void this.adoptRunHost(tabId, runServerId)
      return
    }
    await this.requestPrepare(tabId, session, source, opts.repoKey, isStale)
  }

  /** Ask the run host to sync to `origin`, and adopt it when it answers current. */
  private async requestPrepare(tabId: string, session: Session, origin: SessionSyncOrigin, repoKey: string | null | undefined, isStale: () => boolean): Promise<void> {
    const sessionId = syncedSessionId(session)
    const runServerId = this.deps.resolveId(runHost(session.run))
    const repository = await this.deps.repository(session.run, repoKey ?? this.deps.repoKeyOf(session.run.location) ?? this.deps.cloudRepositoryKeyOf(sessionId))
    if (isStale()) return
    const request: SessionPrepareRequest = { sessionId, knownHead: origin.knownHead }
    const sourceHostId = this.sourceRef(origin)
    if (sourceHostId) request.sourceHostId = sourceHostId
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

  /**
   * "Use the newer copy" after a refused push (design answer 3.4): a prepare
   * with the cloud head makes the run host current, and its conversation is
   * read again. The turns this host ran stay in its provider files; Fork keeps
   * them as a new session.
   */
  async useNewerCopy(tabId: string): Promise<void> {
    const session = this.workspace.sessionFor(tabId)
    const cloud = session ? this.deps.cloudHeadFor(session.id) : null
    if (!session || !cloud?.head) return
    const location = session.run.location
    const origin: SessionSyncOrigin = { knownHead: cloud.head, sourceServerId: cloud.lastRunServerId, sourceHostId: cloud.lastRunHostId }
    this.reloadsConversation.add(session.id)
    await this.requestPrepare(tabId, session, origin, null, () => this.workspace.sessionFor(tabId) !== session || session.run.location !== location)
  }

  /**
   * Before a prompt: while another connected host runs a turn of this session,
   * the prompt goes to that host (plan §4 decision 5), so the tab moves there
   * first, as a Run on pick would move it.
   */
  followRunningHost(tabId: string): void {
    const session = this.workspace.sessionFor(tabId)
    const runningServerId = session ? this.deps.runningServerFor(session.id) : null
    if (!session || !runningServerId || runningServerId === this.deps.resolveId(runHost(session.run))) return
    this.change(tabId, openFolder(session.run.location, { serverId: runningServerId, path: workingPlace(session.run).path }, { keepProject: true }))
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
    if (!meta || this.workspace.sessionFor(tabId) !== session) return
    if (this.deps.resolveId(runHost(session.run)) !== serverId || session.status !== 'idle' && session.status !== 'completed') return
    const reload = this.reloadsConversation.delete(session.id)
    if (reload) this.deps.notePushRefused(serverId, session.id, false)
    // A conversation that came from the cloud with no host, or that this host
    // replaced with the newer copy, is read from the host that has it now.
    if (this.workspace.opening && (reload || this.awaitsRunHost(session))) {
      this.workspace.cloudTranscripts?.release(session.id)
      session.messages.splice(0, session.messages.length)
      await this.workspace.opening.resumeSession(meta, { intoTabId: tabId })
        .catch((error) => console.warn('[Solus] The conversation did not load from the run host.', error))
      return
    }
    if (!meta.cwd) return
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
    const source = this.originFor(session)
    if (!source) return {}
    const fields: Pick<PromptOptions, 'knownHead' | 'sourceHostId' | 'forkSourceSessionId'> = { knownHead: source.knownHead }
    const sourceHostId = this.sourceRef(source)
    if (sourceHostId) fields.sourceHostId = sourceHostId
    if (sessionId !== session.id) fields.forkSourceSessionId = sessionId
    return fields
  }
}
