import { SvelteMap } from 'svelte/reactivity'
import type { AgentId, Message, Session } from '@solus/contracts/types'
import type { SessionHistoryPage, WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { SessionTurnDiff } from '@solus/contracts/session-repositories'
import type { SessionCloudHead, SessionHostTurns } from '@solus/client-core/session-heads'
import { serverConnections } from '@solus/client-core/server-connections'
import {
  readSessionCloudPage,
  sessionCloudReadSource,
  sessionCloudReadView,
  type SessionCloudPage,
  type SessionCloudReadProgress,
  type SessionCloudReadView,
  type SessionTurnDiffView,
} from '@solus/client-core/session-cloud-read'
import { hasSessionStarted } from '../../lib/sessionUtils'
import { accountStore } from '../account/account.store.svelte'
import { sessionListStore } from './session-list.store.svelte'
import { checkoutPlace } from './run-location'
import { loadSessionTranscript } from './session-transcript'
import type { WorkspaceContext } from './workspace.context.svelte'

/** A turn of the cloud copy: its repository index, and when it started. */
export interface CloudTurn {
  index: number
  timestamp: number
}

/** Pages read in a row when the newest turns have no rows, before the copy
 *  says so. Each is one small request. */
const MAX_EMPTY_PAGES = 5

/** The cloud copy of one session, as this client read it. */
class CloudTranscript implements SessionCloudReadProgress {
  status = $state<SessionCloudReadProgress['status']>('loading')
  error = $state<string | null>(null)
  readHead = $state<string | null>(null)
  unavailableTurnCount = $state(0)
  /** The turns read, in the order they arrived (newest first). */
  readonly turns = $state<CloudTurn[]>([])
  readonly diffs = new SvelteMap<number, SessionTurnDiffView>()
  /** When the newest row of the copy was written: a row after it is a live turn. */
  newestRowAt = 0
  private readonly indexes = new Set<number>()
  constructor(readonly apiServerId: string) {}

  /** Keep what a page says of its turn. A page read twice changes nothing. */
  notePage(page: SessionCloudPage): void {
    if (page.turnIndex === undefined || this.indexes.has(page.turnIndex)) return
    this.indexes.add(page.turnIndex)
    if (page.availability === 'not-available' && page.unavailableTurns?.length) this.unavailableTurnCount += 1
    if (page.turnStartedAt !== null) this.turns.push({ index: page.turnIndex, timestamp: page.turnStartedAt })
  }
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
  /** The Solus API connection that holds a session's cloud facts. */
  apiServerFor(sessionId: string): string | null
  cloudHeadFor(sessionId: string): SessionCloudHead | null
  hostTurnsFor(sessionId: string): SessionHostTurns
  isSignedIn(): boolean
  isCloudListed(): boolean
  readPage(apiServerId: string, request: { sessionId: string; provider: AgentId; before?: string }): Promise<SessionCloudPage>
  readDiff(apiServerId: string, sessionId: string, turnIndex: number): Promise<SessionTurnDiff>
  /** Build the tab's messages from a page, as a host's page is built. */
  materialize(tabId: string, session: Session, apiServerId: string, page: SessionHistoryPage, before?: string): Promise<CloudTranscriptPage>
  rebuildAgentConversations(session: Session): void
}

/** The state a conversation draws, and whether it must read the cloud copy first. */
export interface CloudTranscriptState {
  view: SessionCloudReadView | null
  shouldRead: boolean
}

/**
 * The cloud copy of each session that no host shows
 * (docs/plans/portable-sessions-cloud.md, Phase 5B). It reads the copy from
 * the Solus API one turn at a time, newest first, into the tab's own messages,
 * so the usual conversation draws it. Older pages read through the tab's
 * history paging (`reader`). Each read checks that its copy and its tab are
 * still the ones it started for, so a host's rows that arrive first win, and
 * `release` drops every read in flight.
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
    const cloud = this.deps.cloudHeadFor(session.id)
    const source = sessionCloudReadSource({
      hasStarted: hasSessionStarted(session),
      hasHostRows: !copy && (session.messages.length > 0 || session.loadingHistory),
      isSignedIn: this.deps.isSignedIn(),
      isCloudListed: this.deps.isCloudListed(),
      runServerId,
      isRunHostAway,
      runTurn: this.deps.hostTurnsFor(session.id).of(runServerId),
      cloud,
    })
    const isLive = session.status !== 'idle' && session.status !== 'completed'
    const hasLiveRows = isLive || (!!copy && (session.messages.at(-1)?.timestamp ?? 0) > copy.newestRowAt)
    return {
      view: sessionCloudReadView({ source, read: copy ?? null, messageCount: session.messages.length, isTurnLive: hasLiveRows, cloud }),
      shouldRead: source === 'cloud' && !copy,
    }
  }

  /** Read the newest turn of the copy into a tab that shows nothing yet. */
  async open(tabId: string): Promise<void> {
    const session = this.deps.sessionFor(tabId)
    if (!session || this.copies.has(session.id) || session.messages.length > 0) return
    const apiServerId = this.deps.apiServerFor(session.id)
    if (!apiServerId) return
    const copy = new CloudTranscript(apiServerId)
    this.copies.set(session.id, copy)
    const isStale = () => this.copies.get(session.id) !== copy || this.deps.sessionFor(tabId) !== session
    const head = this.deps.cloudHeadFor(session.id)?.head ?? null
    try {
      let before: string | undefined
      for (let read = 0; read < MAX_EMPTY_PAGES; read++) {
        const page = await this.readPage(session, copy, before)
        if (isStale()) return
        const transcript = await this.deps.materialize(tabId, session, apiServerId, page, before)
        if (isStale()) return
        // A host's rows landed first: they are the conversation.
        if (session.messages.length > 0) { this.copies.delete(session.id); return }
        session.messages.push(...transcript.messages)
        session.historyCursor = transcript.before ?? null
        session.historyPendingMessages = transcript.pendingMessages
        session.historyTruncated = session.historyCursor !== null
        if (transcript.messages.length > 0 || session.historyCursor === null) break
        before = session.historyCursor
      }
      this.deps.rebuildAgentConversations(session)
      copy.newestRowAt = session.messages.at(-1)?.timestamp ?? 0
      copy.readHead = head
      copy.status = 'ready'
    } catch (error) {
      if (isStale()) return
      // The state says so in plain words; the cause is for the console.
      console.warn('[Solus] The cloud copy of the session did not load.', error)
      copy.status = 'error'
    }
  }

  /** Read the copy again from its newest turn: after an error, or when the cloud has newer turns. */
  async reload(tabId: string): Promise<void> {
    const session = this.deps.sessionFor(tabId)
    if (!session || !this.copies.has(session.id)) return
    this.copies.delete(session.id)
    session.messages.splice(0, session.messages.length)
    session.historyCursor = null
    session.historyPendingMessages = undefined
    session.historyTruncated = false
    await this.open(tabId)
  }

  /** A host's conversation takes the copy's place: every read in flight is dropped. */
  release(sessionId: string): void {
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

  private async readPage(session: Session, copy: CloudTranscript, before: string | undefined): Promise<SessionCloudPage> {
    // The Solus API reads the session repository, which needs no provider.
    const page = await this.deps.readPage(copy.apiServerId, { sessionId: session.id, provider: session.run.provider ?? 'claude-code', before })
    if (this.copies.get(session.id) === copy) copy.notePage(page)
    return page
  }
}

/** The cloud copy's reads, bound to this client's connections and one workspace. */
export function workspaceCloudTranscriptDeps(workspace: WorkspaceContext): CloudTranscriptDeps {
  return {
    sessionFor: (tabId) => workspace.sessionFor(tabId),
    apiServerFor: (sessionId) => sessionListStore.cloud.apiServerFor(sessionId),
    cloudHeadFor: (sessionId) => sessionListStore.cloud.headFor(sessionId),
    hostTurnsFor: (sessionId) => sessionListStore.hostTurnsFor(sessionId),
    isSignedIn: () => accountStore.state.kind === 'signed-in',
    isCloudListed: () => sessionListStore.cloud.isListed(),
    readPage: (apiServerId, request) => readSessionCloudPage(serverConnections.apiFor(apiServerId), request),
    readDiff: (apiServerId, sessionId, turnIndex) => serverConnections.apiFor(apiServerId).sessionTurnDiff(sessionId, turnIndex),
    materialize: (tabId, session, apiServerId, page, before) => {
      const folder = checkoutPlace(session.run).path
      return loadSessionTranscript(workspace, {
        sessionId: session.id, loadPath: folder, displayCwd: folder,
        provider: session.run.provider ?? workspace.settings.activeAgent,
        ctx: workspace.ctxFor(tabId), turnLimit: 1, before, history: Promise.resolve(page), serverId: apiServerId,
      })
    },
    rebuildAgentConversations: (session) => workspace.eventReducer.rebuildAgentConversations(session),
  }
}
