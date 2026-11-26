import { SvelteMap } from 'svelte/reactivity'
import type { AgentId, Message, Session } from '@solus/contracts/types'
import type { SessionHistoryPage, WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { SessionTurnDiff } from '@solus/contracts/session-repositories'
import { isSolusApiId, solusApiId } from '@solus/contracts/uplink'
import type { SessionCloudHead, SessionHostTurns } from '@solus/client-core/session-heads'
import { serverConnections } from '@solus/client-core/server-connections'
import { INITIAL_HISTORY_TURNS } from '@solus/client-core/session-history-page'
import {
  readSessionCloudPage,
  sessionCloudReadSource,
  sessionCloudReadView,
  type SessionCloudReadProgress,
  type SessionCloudReadView,
  type SessionTurnDiffView,
} from '@solus/client-core/session-cloud-read'
import { readsSessionsFromSolusApi } from '@solus/client-core/session-home'
import { LOCAL_ORGANIZATION_ID } from '../../lib/organization-filter'
import { hasSessionStarted } from '../../lib/sessionUtils'
import { hostSettingsStore } from '../app/host-settings.store.svelte'
import { serversStore } from '../connections/servers.store.svelte'
import { recordHomeOf, RUNNER_NOT_HERE_READ_ONLY_REASON } from './machine-references'
import { sessionListStore } from './session-list.store.svelte'
import { checkoutPlace } from './run-location'
import { loadSessionTranscript } from './session-transcript'
import type { WorkspaceContext } from './workspace.context.svelte'

/** A turn of the cloud copy that has a diff: its index in the mirror, and when it ended. */
export interface CloudTurn {
  index: number
  timestamp: number
}

/** The cloud copy of one session, as this client read it. */
class CloudTranscript implements SessionCloudReadProgress {
  status = $state<SessionCloudReadProgress['status']>('loading')
  error = $state<string | null>(null)
  hasNewerRows = $state(false)
  /** The turns of the pages read that have a diff. */
  readonly turns = $state<CloudTurn[]>([])
  readonly diffs = new SvelteMap<number, SessionTurnDiffView>()
  /** When the newest row of the copy was written: a row after it is a live turn. */
  newestRowAt = 0
  /** Stops the watch for newer rows. */
  stopWatch: () => void = () => {}
  private readonly indexes = new Set<number>()
  constructor(readonly apiServerId: string) {}

  /** Keep the turn diffs a page names. A page read twice changes nothing. */
  notePage(page: SessionHistoryPage): void {
    for (const diff of page.turnDiffs ?? []) {
      if (this.indexes.has(diff.turnIndex)) continue
      this.indexes.add(diff.turnIndex)
      this.turns.push({ index: diff.turnIndex, timestamp: diff.endedAt })
    }
  }
}

/**
 * The Solus API connection that reads a session's copy. The mirror holds a
 * session whatever its session repository says, so no repository fact is
 * needed: the connection that gave facts for the session, else its record home
 * when that is a Solus API, else a Solus API connection of this client (a
 * personal session is in its owner's scope there). Null: this client has none.
 */
export function copyApiServerFor(factsServerId: string | null, homeServerId: string | null, readyApiServerId: () => string | null): string | null {
  if (factsServerId) return factsServerId
  return homeServerId && isSolusApiId(homeServerId) ? homeServerId : readyApiServerId()
}

/** The page a materialized cloud page becomes in the tab. */
export interface CloudTranscriptPage {
  messages: Message[]
  before?: string | null
  pendingMessages?: WireSessionLoadMessage[]
}

/** What the cloud copy reads and calls. Replaced in tests. */
export interface CloudTranscriptDeps {
  sessionFor(tabId: string): Session | undefined
  /** The Solus API connection to ask for a session's copy (`copyApiServerFor`); null when this client has none. */
  apiServerFor(session: Session): string | null
  /** Where the session last ran, to decide whether an online run host holds it. */
  cloudHeadFor(sessionId: string): SessionCloudHead | null
  hostTurnsFor(sessionId: string): SessionHostTurns
  /** The cloud sync setting of the run host, when this client read it and it decides whether the mirror has the session. */
  isCloudSyncOn(session: Session, runServerId: string): boolean | undefined
  /** False when the organization of the session keeps its sessions on their hosts: Solus Cloud has no copy of it, and the Solus API is not asked. */
  savesSessionsToCloud(session: Session): boolean
  readPage(apiServerId: string, request: { sessionId: string; provider: AgentId; before?: string }): Promise<SessionHistoryPage>
  readDiff(apiServerId: string, sessionId: string, turnIndex: number): Promise<SessionTurnDiff>
  /** Hear when the mirror gets rows or a turn diff of a session (`session.transcriptChanged`). Answers the stop. */
  watchRows(apiServerId: string, sessionId: string, onNewerRows: () => void): () => void
  /** Build the tab's messages from a page, as a host's page is built. */
  materialize(tabId: string, session: Session, apiServerId: string, page: SessionHistoryPage): Promise<CloudTranscriptPage>
  rebuildAgentConversations(session: Session): void
}

/** The state a conversation draws, and whether it must read the cloud copy first. */
export interface CloudTranscriptState {
  view: SessionCloudReadView | null
  shouldRead: boolean
}

/**
 * The cloud copy of each session that no host shows
 * (docs/plans/portable-sessions-cloud.md, Phase 5B, "The mirror for readers"). It
 * reads the copy from the Solus API, which answers it from the transcript
 * mirror, one page of turns at a time, newest first, into the tab's own
 * messages, so the usual conversation draws it. Older pages read through the
 * tab's history paging (`reader`). Each read checks that its copy and its tab
 * are still the ones it started for, so a host's rows that arrive first win,
 * and `release` drops every read in flight. Rows that arrive in the mirror
 * later make the copy stale; only the reader's action reads it again, because
 * a new read resets the scroll.
 */
export class CloudTranscriptStore {
  private readonly copies = new SvelteMap<string, CloudTranscript>()

  constructor(private readonly deps: CloudTranscriptDeps) {}

  /** Whether the tab of this session shows (or reads) its cloud copy. */
  shows(sessionId: string): boolean {
    return this.copies.has(sessionId)
  }

  /** The turns of the cloud copy on screen, for their diffs. */
  turnsFor(sessionId: string): readonly CloudTurn[] {
    return this.copies.get(sessionId)?.turns ?? []
  }

  diffFor(sessionId: string, turnIndex: number): SessionTurnDiffView | undefined {
    return this.copies.get(sessionId)?.diffs.get(turnIndex)
  }

  /** What the conversation of `session` shows, with its run host as named. */
  stateFor(session: Session, runServerId: string, isRunHostAway: boolean): CloudTranscriptState {
    const copy = this.copies.get(session.id)
    const hasStarted = hasSessionStarted(session)
    const hasHostRows = !copy && (session.messages.length > 0 || session.loadingHistory)
    const source = sessionCloudReadSource({
      hasStarted,
      hasHostRows,
      // The connection is looked for only when the rule reads it: a started session with no host rows.
      isSignedIn: !hasStarted || hasHostRows || this.deps.apiServerFor(session) !== null,
      runServerId,
      isRunHostAway,
      // A host that is not the session's machine has no copy of an organization session.
      isHostReadUnavailable: session.readOnlyReason === RUNNER_NOT_HERE_READ_ONLY_REASON,
      runTurn: this.deps.hostTurnsFor(session.id).of(runServerId),
      cloud: this.deps.cloudHeadFor(session.id),
    })
    // No host shows the session, and its organization keeps its sessions on their hosts: there is no copy to read.
    if (source !== null && !copy && !this.deps.savesSessionsToCloud(session)) return { view: { kind: 'sync-off' }, shouldRead: false }
    const isLive = session.status !== 'idle' && session.status !== 'completed'
    const hasLiveRows = isLive || (!!copy && (session.messages.at(-1)?.timestamp ?? 0) > copy.newestRowAt)
    return {
      view: sessionCloudReadView({
        source, read: copy ?? null, messageCount: session.messages.length, isTurnLive: hasLiveRows,
        // Only the setting of the machine the tab is on, while it is away, says why the mirror has no row.
        isCloudSyncOn: isRunHostAway ? this.deps.isCloudSyncOn(session, runServerId) : undefined,
      }),
      shouldRead: source === 'cloud' && !copy,
    }
  }

  /** Read the newest turns of the copy into a tab that shows nothing yet. */
  async open(tabId: string): Promise<void> {
    const session = this.deps.sessionFor(tabId)
    if (!session || this.copies.has(session.id) || session.messages.length > 0) return
    if (!this.deps.savesSessionsToCloud(session)) return
    const apiServerId = this.deps.apiServerFor(session)
    if (!apiServerId) return
    const copy = new CloudTranscript(apiServerId)
    this.copies.set(session.id, copy)
    // From before the read: a row that arrives while the page is read may not be in it.
    copy.stopWatch = this.deps.watchRows(apiServerId, session.id, () => { copy.hasNewerRows = true })
    const isStale = () => this.copies.get(session.id) !== copy || this.deps.sessionFor(tabId) !== session
    try {
      const page = await this.readPage(session, copy, undefined)
      if (isStale()) return
      const transcript = await this.deps.materialize(tabId, session, apiServerId, page)
      if (isStale()) return
      // A host's rows landed first: they are the conversation.
      if (session.messages.length > 0) { this.release(session.id); return }
      session.messages.push(...transcript.messages)
      session.historyCursor = transcript.before ?? null
      session.historyPendingMessages = transcript.pendingMessages
      session.historyTruncated = session.historyCursor !== null
      this.deps.rebuildAgentConversations(session)
      copy.newestRowAt = session.messages.at(-1)?.timestamp ?? 0
      copy.status = 'ready'
    } catch (error) {
      if (isStale()) return
      // The state says so in plain words; the cause is for the console.
      console.warn('[Solus] The cloud copy of the session did not load.', error)
      copy.status = 'error'
    }
  }

  /** Read the copy again from its newest turn: after an error, or when the mirror has newer rows. */
  async reload(tabId: string): Promise<void> {
    const session = this.deps.sessionFor(tabId)
    if (!session || !this.copies.has(session.id)) return
    this.release(session.id)
    session.messages.splice(0, session.messages.length)
    session.historyCursor = null
    session.historyPendingMessages = undefined
    session.historyTruncated = false
    await this.open(tabId)
  }

  /** A host's conversation takes the copy's place, or its tab closed: every read in flight is dropped. */
  release(sessionId: string): void {
    this.copies.get(sessionId)?.stopWatch()
    this.copies.delete(sessionId)
  }

  /** Where the tab's older pages come from while it shows the copy. */
  reader(session: Session): { serverId: string; read(before: string): Promise<SessionHistoryPage> } | null {
    const copy = this.copies.get(session.id)
    if (!copy) return null
    return { serverId: copy.apiServerId, read: (before) => this.readPage(session, copy, before) }
  }

  /** Read the diff of one turn of the copy, once; a failed read can be tried again. */
  async loadDiff(sessionId: string, turnIndex: number): Promise<void> {
    const copy = this.copies.get(sessionId)
    const known = copy?.diffs.get(turnIndex)
    if (!copy || (known && known.status !== 'error')) return
    copy.diffs.set(turnIndex, { status: 'loading' })
    try {
      const diff = await this.deps.readDiff(copy.apiServerId, sessionId, turnIndex)
      copy.diffs.set(turnIndex, diff.status === 'available' && diff.patch.trim() === '' ? { status: 'no-change' } : diff)
    } catch {
      copy.diffs.set(turnIndex, { status: 'error' })
    }
  }

  private async readPage(session: Session, copy: CloudTranscript, before: string | undefined): Promise<SessionHistoryPage> {
    // The Solus API reads the mirror, which needs no provider.
    const page = await this.deps.readPage(copy.apiServerId, { sessionId: session.id, provider: session.run.provider ?? 'claude-code', before })
    if (this.copies.get(session.id) === copy) copy.notePage(page)
    return page
  }
}

/** The cloud copy's reads, bound to this client's connections and one workspace. */
export function workspaceCloudTranscriptDeps(workspace: WorkspaceContext): CloudTranscriptDeps {
  return {
    sessionFor: (tabId) => workspace.sessionFor(tabId),
    apiServerFor: (session) => copyApiServerFor(
      sessionListStore.cloud.apiServerFor(session.id),
      sessionListStore.listed(session.id)?.homeServerId ?? recordHomeOf(session),
      readySolusApiId,
    ),
    cloudHeadFor: (sessionId) => sessionListStore.cloud.headFor(sessionId),
    hostTurnsFor: (sessionId) => sessionListStore.hostTurnsFor(sessionId),
    // The mirror holds an organization session whatever this setting says.
    isCloudSyncOn: (session, runServerId) => recordHomeOf(session) ? undefined : hostSettingsStore.states.get(runServerId)?.sessionCloudSync,
    savesSessionsToCloud: (session) => {
      const { organizationId } = session
      return !organizationId || organizationId === LOCAL_ORGANIZATION_ID || readsSessionsFromSolusApi(organizationId, serversStore)
    },
    readPage: (apiServerId, request) => readSessionCloudPage(serverConnections.apiFor(apiServerId), request),
    readDiff: (apiServerId, sessionId, turnIndex) => serverConnections.apiFor(apiServerId).sessionTurnDiff(sessionId, turnIndex),
    watchRows: (apiServerId, sessionId, onNewerRows) => serverConnections.eventsFor(apiServerId).subscribe('session.transcriptChanged', (event) => {
      if (event.sessionId === sessionId) onNewerRows()
    }),
    materialize: (tabId, session, apiServerId, page) => {
      const folder = checkoutPlace(session.run).path
      return loadSessionTranscript(workspace, {
        sessionId: session.id, loadPath: folder, displayCwd: folder,
        provider: session.run.provider ?? workspace.settings.activeAgent,
        ctx: workspace.ctxFor(tabId), turnLimit: INITIAL_HISTORY_TURNS, history: Promise.resolve(page), serverId: apiServerId,
      })
    },
    rebuildAgentConversations: (session) => workspace.eventReducer.rebuildAgentConversations(session),
  }
}

/** A Solus API connection of this client that is ready: the one of the window's organization first. */
function readySolusApiId(): string | null {
  const isReady = (serverId: string) => serversStore.readinessFor(serverId).readiness === 'ready'
  const active = serversStore.activeCloudServerId
  if (active && isReady(active)) return active
  return serversStore.workspaces.map((workspace) => solusApiId(workspace.organizationId)).find(isReady) ?? null
}
