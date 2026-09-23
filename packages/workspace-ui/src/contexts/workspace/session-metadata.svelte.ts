import type { SessionTitleChangedEvent } from '@solus/contracts/types'
import { SvelteSet } from 'svelte/reactivity'
import { sessionTitleRegenerationInput } from './session-title-regeneration'
import { isDispatch } from './run-config'
import { applySessionTitleChange } from './session-title-change'
import { serverConnections } from '@solus/client-core/server-connections'
import { hasHostCapability } from '@solus/client-core/host-capabilities'
import type { WorkspaceContext } from './workspace.context.svelte'

/** The workspace members this controller reads or calls, and no others. */
type SessionMetadataWorkspace = Pick<WorkspaceContext,
  | 'addSystemMessage'
  | 'apiFor'
  | 'createThreadGoal'
  | 'dispatch'
  | 'promptComposer'
  | 'refreshThreadGoal'
  | 'revealGoal'
  | 'sessionFor'
  | 'sessions'
  | 'settings'
  | 'tabIdsForSession'
  | 'tabs'
  | 'tasksStore'
>

/**
 * What a session is called and whether it has been read: generated and manual
 * titles, the host's read state, and the goal a new session was started with.
 * The name belongs to the session, so every tab showing it reads the same one.
 */
export class SessionMetadata {
  constructor(private readonly workspace: SessionMetadataWorkspace) {}

  async definePendingGoal(tabId: string): Promise<void> {
    const session = this.workspace.sessionFor(tabId)
    const objective = session?.pendingGoalObjective?.trim()
    if (!session?.agentSessionId || !session.run.provider || !objective) return
    try {
      await this.workspace.refreshThreadGoal(session.id)
      if (session.goal) {
        session.pendingGoalObjective = null
        this.workspace.revealGoal(tabId)
        return
      }
      session.pendingGoalObjective = null
      await this.workspace.createThreadGoal(session.id, objective)
      this.workspace.revealGoal(tabId)
    } catch (error) {
      session.pendingGoalObjective = objective
      this.workspace.addSystemMessage(
        `Couldn't create goal: ${error instanceof Error ? error.message : String(error)}`,
        tabId,
      )
    }
  }

  /** Tabs whose auto-name has been attempted. Both providers can re-emit
   *  session_init for a live session (Claude does it when a background task
   *  resumes the parent), and naming is a paid round trip — once per tab. */
  metadataFinalizedTabs = new Set<string>()

  readonly regeneratingTitleSessionIds = new SvelteSet<string>()

  /**
   * Adopt the host's read state for a session. The event arrives for a read
   * made on any device, so this is what makes opening a session on the desktop
   * clear its indicator on the phone.
   *
   * The host's answer is taken as-is rather than merged with a local guess:
   * two mounted surfaces disagreeing about what has been read is the failure
   * this replaced.
   */
  applySessionReadState(sessionId: string, viewedAt: number | null): void {
    const unread = viewedAt === null
    for (const tabId of this.workspace.tabIdsForSession(sessionId)) {
      const tab = this.workspace.tabs[tabId]
      // One property, never a spread: this runs on an event that can arrive
      // during streaming, and replacing the tab invalidates every derived
      // reading it.
      if (tab && tab.hasUnread !== unread) tab.hasUnread = unread
    }
  }

  /**
   * Tell the session's host it has been read. Fire-and-forget: the indicator
   * has already cleared locally, and the broadcast that follows is what the
   * other clients act on. A host too old to know the method simply keeps its
   * previous per-client behaviour.
   */
  publishSessionViewed(sessionId: string): void {
    const serverId = this.workspace.sessions.byId[sessionId]?.run.serverId
    if (!serverId) return
    void serverConnections.apiFor(serverId)
      .setSessionReadState(sessionId, Date.now())
      .catch(() => {})
  }

  applySessionTitleChanged(
    serverId: string,
    event: SessionTitleChangedEvent,
  ): void {
    for (const { sessionId, taskServerId } of applySessionTitleChange(this.workspace.sessions.byId, serverId, event)) {
      for (const tabId of this.workspace.tabIdsForSession(sessionId)) this.metadataFinalizedTabs.add(tabId)
      if (taskServerId === serverId) continue
      // A dispatched session is indexed on its execution host, while its task
      // host holds a lightweight proxy row for closed-attempt display. Carry
      // the authoritative rename back across that boundary; otherwise only the
      // borrowed host learns the generated name.
      void serverConnections.apiFor(taskServerId)
        .setSessionTitle(sessionId, event.title, event.source, event.generatedDescription, false)
        .then(() => this.workspace.tasksStore.refreshSessionBinding(sessionId, taskServerId))
        .catch(() => null)
    }
  }

  /**
   * Name a thread and describe its session-born ticket from the opening prompt,
   * once its agent session id exists to persist against. Silent on failure: the
   * prompt-derived title and empty ticket body are valid fallbacks.
   */
  async generateSessionMetadata(tabId: string): Promise<void> {
    const tab = this.workspace.tabs[tabId]
    const session = this.workspace.sessionFor(tabId)
    const agentSessionId = session?.agentSessionId
    if (!tab || !session || !agentSessionId || session.forked) return
    if (this.metadataFinalizedTabs.has(tabId)) return

    if (session.titleCustom) {
      // A name typed into a session before the provider knew about it had
      // nowhere to persist — this is the first moment there's an id to hang it on.
      this.metadataFinalizedTabs.add(tabId)
      await this.workspace.apiFor(tabId).setSessionTitle(agentSessionId, session.title, 'manual').catch(() => {})
      return
    }
    if (!this.workspace.settings.autoRenameSessions) return

    // Only the opening turn names a thread — a later init is a resume, and a
    // resumed thread either has a name already or was deliberately left unnamed.
    const userMessages = session.messages.filter((message) => message.role === 'user' && message.content)
    if (userMessages.length !== 1) return
    this.metadataFinalizedTabs.add(tabId)

    const runServerId = serverConnections.resolveId(session.run.serverId)
    const metadataContext = this.workspace.promptComposer.composeSessionMetadataContext(
      userMessages[0].attachments ?? [],
      runServerId,
      hasHostCapability(serverConnections.cachedCapabilitiesFor(runServerId), 'promptImageRefs'),
    )
    const metadata = await this.workspace.apiFor(tabId)
      .generateSessionMetadata(userMessages[0].content, session.run.workingDirectory, metadataContext)
      .catch(() => null)
    if (!metadata) return

    // The tab may have been closed, reset, renamed by hand, or resumed into a
    // different session while the naming round trip was in flight.
    const currentSession = this.workspace.sessionFor(tabId)
    if (!this.workspace.tabs[tabId] || !currentSession || currentSession.titleCustom) return
    if (currentSession.agentSessionId !== agentSessionId) return
    currentSession.title = metadata.title
    // The session's host names the session-born task from this title itself,
    // with its own race guards against a hand-typed name. A dispatched session's
    // task sits on a host that never sees that call, so the client carries the
    // name across — only to the task it minted, never to one the user chose.
    const mintedTaskId = this.workspace.dispatch.mintedTaskIdBySession.get(currentSession)
    if (mintedTaskId && isDispatch(currentSession.run)) {
      void this.workspace.tasksStore.get(mintedTaskId).update({
        title: metadata.title,
        body: metadata.description,
      }).catch(() => null)
    }
    await this.workspace.apiFor(tabId)
      .setSessionTitle(agentSessionId, metadata.title, 'generated', metadata.description)
      .catch(() => {})
  }

  /** Rename a session by hand, named by a tab showing it. An empty name clears
   *  back to the derived title. Every view of the session sees the new name,
   *  because the name is the session's. */
  async renameTab(tabId: string, title: string): Promise<void> {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    const trimmed = title.trim()
    // 'New Tab' is what sessionTitle() reads as "unnamed", so clearing a name
    // there falls the display back to the session's first prompt.
    session.title = trimmed || 'New Tab'
    session.titleCustom = !!trimmed
    // A pending fork carries its source's provider ID only to branch from it.
    // Keep the name local until session_init gives the fork its own ID.
    if (session.agentSessionId && !session.forked) {
      this.metadataFinalizedTabs.add(tabId)
      await this.workspace.apiFor(tabId).setSessionTitle(session.agentSessionId, trimmed || null, 'manual')
    }
  }

  /** Replace a session's name from its opening prompt. This names only the
   * conversation: a task linked to it keeps its separately owned title. */
  async regenerateTabTitle(tabId: string): Promise<void> {
    const session = this.workspace.sessionFor(tabId)
    const agentSessionId = session?.agentSessionId
    if (!session || !agentSessionId) {
      throw new Error("Couldn't find the session's opening prompt.")
    }
    if (this.regeneratingTitleSessionIds.has(agentSessionId)) {
      throw new Error('The session title is already regenerating.')
    }

    this.regeneratingTitleSessionIds.add(agentSessionId)
    try {
      const api = this.workspace.apiFor(tabId)
      let workingDirectory = session.run.workingDirectory
      let openingPrompt = sessionTitleRegenerationInput(session.messages)
      if (!openingPrompt) {
        const indexedSession = await api.getSessionInfo(agentSessionId)
        openingPrompt = sessionTitleRegenerationInput([], indexedSession?.firstMessage)
        workingDirectory = indexedSession?.cwd || workingDirectory
      }
      if (!openingPrompt) throw new Error("Couldn't find the session's opening prompt.")

      const runServerId = serverConnections.resolveId(session.run.serverId)
      const metadataContext = this.workspace.promptComposer.composeSessionMetadataContext(
        session.messages.flatMap((message) => message.role === 'user' ? message.attachments ?? [] : []),
        runServerId,
        hasHostCapability(serverConnections.cachedCapabilitiesFor(runServerId), 'promptImageRefs'),
      )
      const metadata = await api.generateSessionMetadata(
        openingPrompt,
        workingDirectory,
        metadataContext,
      )
      if (!metadata) throw new Error("Couldn't generate a new session title.")

      const currentSession = this.workspace.sessionFor(tabId)
      if (!currentSession || currentSession.agentSessionId !== agentSessionId) {
        throw new Error('The session changed before its new title was ready.')
      }
      currentSession.title = metadata.title
      currentSession.titleCustom = true
      if (!currentSession.forked) {
        this.metadataFinalizedTabs.add(tabId)
        await api.setSessionTitle(agentSessionId, metadata.title, 'generated')
      }
    } finally {
      this.regeneratingTitleSessionIds.delete(agentSessionId)
    }
  }
}
