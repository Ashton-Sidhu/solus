import { hostRolesStore } from '../connections/host-roles.store.svelte'
import type { AgentId, Session, RunConfig, Message, SessionDescription, SessionMeta } from '@solus/contracts/types'
import type { Via } from '@solus/contracts/analytics-events'
import type { SurfaceContext } from '../app/surface-context.svelte'
import { findOpenTabForSession } from '../../lib/sessionUtils'
import { uuid } from '@solus/contracts/uuid'
import { projectsStore } from '../projects/projects.store.svelte'
import { serversStore } from '../connections/servers.store.svelte'
import { chooseRunOnHost, type RunOnHost } from '../projects/run-on-rule'
import { hostIsManaged } from '../../components/servers/lib/managed-host'
import { isRepositoryKey } from '@solus/contracts/repository-key'
import { type Task } from '@solus/contracts/task-types'
import { toasts } from '../../lib/toasts'
import { makeSession, makeTab } from './session.factories'
import { worktreeProjectRoot, gitCheckoutFromState, isSolusWorktreePath } from '@solus/contracts/types'
import { loadSessionTranscript, RESTORED_TRANSCRIPT_LIMIT } from './session-transcript'
import { track } from '../../lib/analytics'
import { requestInputFocus } from '../../lib/inputFocus'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { reviewGuideStore, sessionGuideIdentity } from '../../components/review/review-guide.store.svelte'
import { ownedTaskId } from './session-draft.svelte'
import { type GitRefreshResult } from '../git/session-environment.store.svelte'
import { findLastUserIndex } from './session.utils'
import { requestConversationScrollToBottom } from './session-plan-operations'
import { SessionUnavailableError } from './session-errors'
import { quotedReplyDraft } from '../../lib/quoted-reply'
import type { SessionEnvironmentWorkspace } from '../git/session-environment.store.svelte'
import type { WorkspaceContext, ForkTabOptions } from './workspace.context.svelte'

/** The lineage and answering member's metadata for a saved session. One read on
 *  a current host; a host that predates `describeSession` rejects the method,
 *  and the two reads it replaced still answer there. */
async function describeSavedSession(api: HostApi, provider: AgentId, providerSessionId: string): Promise<SessionDescription> {
  try {
    return await api.describeSession(provider, providerSessionId)
  } catch {
    const lineage = await api.resolveSessionLineage(provider, providerSessionId)
    const active = lineage?.active
    if (active && !active.providerSessionId) return { lineage, meta: null }
    return { lineage, meta: await api.getSessionInfo(active?.providerSessionId ?? providerSessionId) }
  }
}

/** The workspace members this controller reads or calls, and no others. */
type SessionOpeningWorkspace = Pick<WorkspaceContext,
  | 'activeSession'
  | 'activeTab'
  | 'activeTabId'
  | 'addTabToOrder'
  | 'adoptSessionId'
  | 'apiFor'
  | 'applyRuntimeAttach'
  | 'config'
  | 'createTab'
  | 'ctxFor'
  | 'dispatch'
  | 'drafts'
  | 'environment'
  | 'eventReducer'
  | 'lifecycle'
  | 'openSessionRecord'
  | 'openSplitChat'
  | 'planStore'
  | 'pluginCommands'
  | 'promoteSplitToMainTab'
  | 'resetOverlays'
  | 'router'
  | 'runFor'
  | 'selectTab'
  | 'serverIdFor'
  | 'sessionFor'
  | 'sessions'
  | 'setActiveTab'
  | 'settings'
  | 'showExplicitSidebarTaskSession'
  | 'splitChatTabId'
  | 'staticInfo'
  | 'tabOrder'
  | 'tabs'
  | 'tasksStore'
  | 'ui'
> & SurfaceContext & SessionEnvironmentWorkspace

/**
 * Conversations that start from another one: a saved session resumed from
 * disk or another host, a fork, a question asked in a fresh session, and a
 * conversation continued in its own worktree. Each creates the session and
 * then asks the workspace to show it.
 */
export class SessionOpening {
  constructor(private readonly workspace: SessionOpeningWorkspace) {}

  /**
   * Open a new tab set to materialize a fresh worktree on its first prompt.
   * Mirrors how worktrees are created everywhere else in Solus (lazy, with an
   * AI-generated branch name) rather than creating one on disk immediately.
   */
  async createWorktreeTab(): Promise<void> {
    const src = this.workspace.activeSession
    const projectRoot = src?.run.gitContext?.repoRoot
      ?? (src?.run.workingDirectory && src.run.workingDirectory !== '~' ? worktreeProjectRoot(src.run.workingDirectory) : undefined)
    const draft = this.workspace.drafts.openSessionDraft({ worktreeRequested: true }, projectRoot)
    // Always branch off the project root, even when the source was itself inside
    // a worktree whose checkout the draft would otherwise inherit.
    draft.run.gitContext = null
    draft.run.worktree = { baseBranch: null }
    const dir = draft.run.workingDirectory
    if (!dir || dir === '~') return
    await this.workspace.config.refreshSessionStartTarget(draft.id, dir, true)
  }

  /** Fork a session into a new tab. The fork inherits the transcript through the
   *  source's last settled turn, resumes on first prompt, and joins the exact
   *  task the source is working. */
  async forkTab(sourceTabId: string, options: ForkTabOptions = {}): Promise<string | null> {
    const sourceSession = this.workspace.sessionFor(sourceTabId)
    if (!sourceSession?.agentSessionId) return null

    // The fork's own session is watched when it is first prompted, so nothing
    // needs to reach the host here.
    const tabId = uuid()

    const originalTitle = sourceSession.title || 'session'
    // Forking mid-turn branches from the last settled point, not from the turn
    // still being written: its messages are half-formed (tools still spinning)
    // and the fork's own first prompt lands later anyway. Cut the in-flight turn
    // out of the copy and say so on the divider.
    const sourceIsRunning = sourceSession.status === 'running' || sourceSession.status === 'connecting'
    const inFlightFrom = sourceIsRunning ? findLastUserIndex(sourceSession.messages) : -1
    const settledMessages = inFlightFrom === -1
      ? sourceSession.messages
      : sourceSession.messages.slice(0, inFlightFrom)
    const copiedMessages: Message[] = settledMessages.map((m) => ({ ...m, id: uuid() }))
    const forkInfoMsg: Message = {
      id: uuid(),
      role: 'system',
      content: '',
      timestamp: Date.now(),
      forkSourceSessionId: sourceSession.agentSessionId,
      forkSourceTitle: originalTitle,
    }
    if (inFlightFrom !== -1) forkInfoMsg.forkSourceRunning = true

    const taskId = ownedTaskId(this.workspace.tasksStore, sourceSession)
    const forkTask: Session['task'] = taskId
      ? { kind: 'existing', taskId }
      : { ...sourceSession.task }
    const forkedSession = makeSession(this.workspace.settings, {
      agentSessionId: sourceSession.agentSessionId,
      forked: true,
      forkExcludeLatestTurn: sourceIsRunning && inFlightFrom !== -1,
      // Source provenance lives on the divider. It is not an identity alias:
      // this fork and its source remain separate sessions.
      forkedFromSessionId: null,
      messages: [...copiedMessages, forkInfoMsg],
      additionalDirs: [...sourceSession.additionalDirs],
      // A fork runs exactly where its source does.
      run: {
        ...sourceSession.run,
        modelConfig: { ...sourceSession.run.modelConfig },
        gitContext: sourceSession.run.gitContext ? { ...sourceSession.run.gitContext } : null,
        sessionSkills: [...sourceSession.run.sessionSkills],
      },
      pluginCommands: this.workspace.pluginCommands,
      // Both entry points keep the exact source task.
      task: options.task ?? forkTask,
    })

    forkedSession.title = `Fork: ${originalTitle}`
    const forkTab = makeTab(forkedSession.id, { id: tabId })

    this.workspace.sessions.byId[forkedSession.id] = forkedSession
    this.workspace.tabs[forkTab.id] = forkTab
    this.workspace.addTabToOrder(forkTab.id)
    if (options.activate !== false) {
      this.workspace.setActiveTab(forkTab.id)
      this.workspace.resetOverlays()
    }
    void this.workspace.environment.refreshEnvironment(this.workspace, { sourceId: tabId, force: false }).catch(() => null)
    if (options.activate !== false) requestInputFocus()
    return tabId
  }

  /**
   * Branch selected transcript text into a contextual session beside its source.
   * The provider fork remains lazy until the user sends the targeted question.
   */
  async askInNewSession(sourceTabId: string, selectedText: string): Promise<void> {
    const draft = quotedReplyDraft(selectedText)
    const sourceSession = this.workspace.sessionFor(sourceTabId)
    if (!draft || !sourceSession?.agentSessionId) return

    const splitTabId = this.workspace.splitChatTabId
    if (splitTabId === sourceTabId) this.workspace.promoteSplitToMainTab()
    else if (sourceTabId !== this.workspace.activeTabId) this.workspace.selectTab(sourceTabId)

    const taskId = ownedTaskId(this.workspace.tasksStore, sourceSession)
    const forkTabId = await this.forkTab(sourceTabId, {
      activate: false,
      task: taskId ? { kind: 'existing', taskId } : { ...sourceSession.task },
    })
    if (!forkTabId) return
    const forked = this.workspace.sessionFor(forkTabId)!
    forked.prompt.text = draft
    this.workspace.openSplitChat(forked.id)
    requestInputFocus({ tabId: forkTabId })
  }

  /** Move a live session into a fresh git worktree. Creates the worktree now (so
   *  the branch name and git panel update immediately), then flags the session to
   *  fork on its next prompt — that fork re-homes the conversation's transcript
   *  under the worktree, so the session truly lives there. Same tab, same history. */
  async continueInWorktree(tabId: string, via: Via = 'click'): Promise<void> {
    void via
    const session = this.workspace.sessionFor(tabId)
    if (!session?.agentSessionId || session.run.gitContext?.worktreePath || this.workspace.ui.isContinuingInWorktree(tabId)) return

    const firstUser = session.messages.find((m) => m.role === 'user')
    const namePrompt = firstUser?.content.slice(0, 200) ?? ''

    this.workspace.ui.beginContinueInWorktree(tabId)
    // Live status card while the (eager, ~1-2s) `git worktree add` runs,
    // mirroring the backend's new-session card so the wait shows progress
    // instead of a bare "Creating Worktree…" label. The host names the branch
    // afterwards and sends the new name as a `git_context` event.
    session.statusCard = {
      id: `continue-worktree-${tabId}`,
      title: 'Moving into a new worktree…',
      icon: 'git-branch',
      status: 'active',
      steps: [
        { id: 'worktree', label: 'Creating the worktree', status: 'active' },
        { id: 'session', label: 'Moving this.workspace session in', status: 'pending' },
      ],
    }
    try {
      const result = await this.workspace.apiFor(tabId).continueInWorktree(this.workspace.ctxFor(tabId), namePrompt)
      if (!result.success || !result.gitContext) {
        toasts.error("Couldn't create worktree", { description: result.error })
        return
      }

      // Keep agentSessionId as the fork source; forked=true makes the next run resume
      // it with --fork-session in the worktree cwd (see control-plane dispatch).
      session.run.gitContext = result.gitContext
      session.run.worktree = null
      // The session moved to a different checkout after its initial environment
      // refresh. Refresh the whole session target so the new cwd, generated
      // worktree name, Git status, refs, and host registration move together.
      void this.workspace.environment.refreshEnvironment(this.workspace, {
        sourceId: tabId,
        level: 'full',
        force: true,
      }).catch(() => null)
      session.forkedFromSessionId = session.agentSessionId
      session.forked = true
      session.messages.push({
        id: uuid(),
        role: 'system',
        content: '',
        timestamp: Date.now(),
        worktreeMovedTo: result.gitContext.branch ?? result.gitContext.detachedHeadSha ?? 'detached HEAD',
        worktreeMovedToPath: result.gitContext.worktreePath,
      })
      requestInputFocus()
    } finally {
      // Clear the setup card whether we succeeded (the "Continued in worktree"
      // divider now marks completion) or failed (toast already shown). Nothing
      // runs here, so no status_change will clear it for us.
      if (session.statusCard?.id === `continue-worktree-${tabId}`) session.statusCard = null
      this.workspace.ui.endContinueInWorktree(tabId)
    }
  }

  async resumeSession(
    meta: SessionMeta,
    opts?: { background?: boolean; intoTabId?: string },
  ): Promise<string> {
    // A session ref crossing the client names its host — there is no probe.
    if (!meta.serverId) throw new Error(`Session ${meta.sessionId} names no host`)
    // The workspace service keeps the record and no transcript: while the runner
    // is offline the session opens read-only (docs/plans/cloud-service-model.md R8).
    if (!hostRolesStore.hasExecution(meta.serverId)) {
      this.workspace.openSessionRecord(meta.sessionId, meta.serverId)
      return ''
    }
    const selectedProvider = meta.provider ?? this.workspace.settings.activeAgent
    const selectedApi = serverConnections.apiFor(meta.serverId)
    // One read answers both what the client used to ask in turn: the lineage,
    // then the metadata of whichever member answers for it.
    const { lineage: handoff, meta: describedMeta } = await describeSavedSession(selectedApi, selectedProvider, meta.sessionId)
    const stableSessionId = handoff?.sessionId ?? meta.sessionId
    const activeMember = handoff?.active
    let activeProviderSessionId: string | null = meta.sessionId
    if (activeMember?.providerSessionId) {
      if (!describedMeta) throw new SessionUnavailableError(activeMember.providerSessionId)
      meta = {
        ...meta,
        ...describedMeta,
        provider: activeMember.provider,
        sessionId: activeMember.providerSessionId,
        cwd: activeMember.cwd,
        serverId: meta.serverId,
      }
      activeProviderSessionId = activeMember.providerSessionId
    } else if (activeMember) {
      meta = { ...meta, provider: activeMember.provider, cwd: activeMember.cwd }
      activeProviderSessionId = null
    } else {
      if (!describedMeta) throw new SessionUnavailableError(meta.sessionId)
      meta = { ...meta, ...describedMeta, serverId: meta.serverId }
    }
    const background = opts?.background ?? false
    const intoTabId = opts?.intoTabId
    const provider = meta.provider ?? this.workspace.settings.activeAgent
    if (!intoTabId) {
      const openTabId = findOpenTabForSession(
        stableSessionId,
        this.workspace.tabs,
        this.workspace.sessions.byId,
        this.workspace.tabOrder,
        provider,
        meta.serverId,
      )
      if (openTabId) {
        if (!background) {
          if (openTabId === this.workspace.activeTabId) {
            // Already the active tab, so nothing switches — but a draft or page
            // may still be sitting over the conversation being asked for.
            this.workspace.resetOverlays({ closeArtifact: true })
          } else this.workspace.selectTab(openTabId)
        }
        return openTabId
      }
    }
    const defaultDir = meta.cwd || this.workspace.staticInfo?.homePath || '~'
    const workingDirectory = worktreeProjectRoot(defaultDir)
    const title = meta.customTitle
      ? meta.customTitle
      : meta.firstMessage
        ? meta.firstMessage.length > 80 ? meta.firstMessage.substring(0, 80) : meta.firstMessage
        : meta.slug || 'Resumed'

    const hadActiveTab = !!this.workspace.activeTab
    let tabId = intoTabId ?? this.workspace.activeTabId
    const targetTab = intoTabId ? this.workspace.tabs[intoTabId] : this.workspace.activeTab
    const targetSession = intoTabId ? this.workspace.sessionFor(intoTabId) : this.workspace.activeSession
    const canTakeOver = targetTab && targetSession && !targetSession.agentSessionId
      && targetSession.status !== 'connecting' && targetSession.status !== 'running'
      && targetSession.messages.length === 0
    if (intoTabId && !canTakeOver) {
      throw new Error('A session can only resume into an empty, idle tab')
    }
    const shouldCreateNewTab = !intoTabId && (background || !canTakeOver)
    if (shouldCreateNewTab) {
      const shouldActivate = !background || !hadActiveTab
      tabId = await this.workspace.createTab(workingDirectory, {
        activate: shouldActivate,
        gitContext: null,
        // This path reads identity, registers the checkout, and reads the
        // directory's commands itself below; the tab must not do it too.
        gitInitialization: 'skip',
        skipPluginCommands: true,
        worktreeRequested: false,
        // A session never moves between machines: resuming one the picker found
        // on another host has to open against that host, not this client's.
        serverId: meta.serverId,
      })
      const session = this.workspace.sessionFor(tabId)
      const tab = this.workspace.tabs[tabId]
      if (!session || !tab) throw new Error('The resumed session tab was not created')
      session.run.provider = provider
      session.agentSessionId = activeProviderSessionId
      session.handoffId = handoff?.sessionId
      session.readOnlyReason = null
      session.loadingHistory = true
      session.title = title
      session.titleCustom = !!meta.customTitle
      if (shouldActivate) {
        if (this.workspace.settings.activeAgent !== provider) {
          this.workspace.config.followActiveSessionAgent(provider)
        }
      }
    } else {
      const session = targetSession!
      session.run.provider = provider
      session.agentSessionId = activeProviderSessionId
      session.handoffId = handoff?.sessionId
      // Taking over an empty tab moves it to the session's host. Safe only
      // because takeover already requires a tab that has started nothing.
      if (meta.serverId) session.run.serverId = meta.serverId
      session.run.workingDirectory = workingDirectory
      session.messages.splice(0, session.messages.length)
      this.workspace.eventReducer.rebuildAgentConversations(session)
      session.readOnlyReason = null
      session.run.gitContext = null
      session.loadingHistory = true
      session.title = title
      session.titleCustom = !!meta.customTitle

      if (!background && !intoTabId) {
        this.workspace.setActiveTab(targetTab!.id)
        if (this.workspace.settings.activeAgent !== provider) {
          this.workspace.config.followActiveSessionAgent(provider)
        }
      }
    }
    if (!background && !intoTabId) {
      this.workspace.resetOverlays()
    }

    // Main is authoritative on session identity. This client read the provider
    // thread off disk and minted a local id for it; if another client already
    // has that thread open, main answers with *its* id and we adopt it. Without
    // this the two clients hold different addresses for one session and "one id"
    // is only true within a client. The same round trip attaches to the live
    // runtime, which is what a separate bind used to do after the watch.
    //
    // It is deliberately not awaited with the transcript below. It supplies only
    // chrome around the conversation — status, rate limits, queued prompts — so
    // joining it to that Promise.all made the spinner outlive the transcript. It
    // is awaited at the end of the resume instead, once the conversation is on
    // screen. Settled rather than left to reject on its own: the join point is
    // several awaits away, so a failure before then would otherwise surface as an
    // unhandled rejection. It is carried and re-thrown at the join instead.
    const runtimeAttach = this.workspace.apiFor(tabId).watchSession({
      sessionId: stableSessionId,
      agentSessionId: activeProviderSessionId ?? undefined,
      provider,
      attachRuntime: !!activeProviderSessionId,
    })
      .then(
        (watched) => {
          this.workspace.adoptSessionId(tabId, watched.sessionId)
          this.workspace.applyRuntimeAttach(tabId, watched.runtime)
          return null
        },
        // With no runtime to attach, a failed watch costs only the identity
        // adoption and is not worth failing the resume over.
        (error: unknown) => activeProviderSessionId
          ? (error instanceof Error ? error : new Error(String(error)))
          : null,
      )

    // Transcript display does not wait for git or task metadata. Each background
    // result checks that this tab still owns the session before applying it.
    const worktreePath = isSolusWorktreePath(defaultDir) ? defaultDir : undefined
    const resumingSession = this.workspace.sessionFor(tabId)
    // Re-read the tab's session before applying anything: a concurrent resume
    // could have taken over this tab while our IPC was in flight.
    const currentResumeTarget = (): Session | null => {
      const s = this.workspace.sessionFor(tabId)
      return s && s === resumingSession ? s : null
    }

    try {
      const api = this.workspace.apiFor(tabId)
      const identityPending = api.gitIdentity
        ? api.gitIdentity(defaultDir).catch(() => null)
        : Promise.resolve(null)
      void this.workspace.tasksStore.ensureSessionBinding(stableSessionId, this.workspace.runFor(tabId)?.taskServerId).catch(() => null)
      const transcript = await loadSessionTranscript(this.workspace, {
        sessionId: stableSessionId,
        loadPath: meta.projectPath || defaultDir,
        displayCwd: workingDirectory,
        provider,
        ctx: this.workspace.ctxFor(tabId),
        limit: RESTORED_TRANSCRIPT_LIMIT,
      })

      const session = currentResumeTarget()
      if (session) {
        // Paint before registering the environment: the transcript is in hand,
        // and nothing below changes what the conversation renders. Clearing the
        // spinner here rather than in the `finally` keeps a round trip the reader
        // cannot see off the front of the first frame.
        session.messages.splice(0, session.messages.length, ...transcript.messages)
        this.workspace.eventReducer.rebuildAgentConversations(session)
        session.progress = transcript.progress
        session.historyTruncated = transcript.truncated
        session.historyCursor = transcript.before
        session.historyPendingMessages = transcript.pendingMessages
        session.loadingHistory = false
        requestConversationScrollToBottom(tabId)

        void (async () => {
          const identity = await identityPending
          const restoredSession = currentResumeTarget()
          if (!restoredSession) return
          // Changed files before the checkout: the session guide is probed from
          // both, and settling the file set first means the probe fires once
          // with the right revision instead of once empty and once again.
          this.workspace.lifecycle.recomputeChangedFiles(tabId)
          const gitContext = gitCheckoutFromState(identity, worktreePath)
          restoredSession.run.gitContext = gitContext
          if (gitContext) restoredSession.readOnlyReason = null
          const guideIdentity = sessionGuideIdentity(restoredSession)
          if (guideIdentity && (!background || !!intoTabId)) {
            // Same identity as `trackSessionReviewGuides`, so the store answers
            // both from one request.
            void reviewGuideStore.acknowledgeSessionGuide(
              api, this.workspace.serverIdFor(tabId), this.workspace.ctxFor(tabId), guideIdentity,
            )
          }
          await this.workspace.environment.registerEnvironment(this.workspace, tabId, worktreePath ?? workingDirectory, gitContext)
          if (!currentResumeTarget()) return
          let environmentRefresh: Promise<GitRefreshResult> | null = null
          // The identity read above already answers whether a worktree is still
          // there: a checkout means it is, null means its branch is gone.
          if (worktreePath && !gitContext) {
            restoredSession.run.gitContext = null
            restoredSession.readOnlyReason = 'This session is read-only because its worktree no longer exists.'
          } else {
            environmentRefresh = this.workspace.environment.refreshEnvironment(this.workspace, { sourceId: tabId, level: 'full', force: false })
          }

          void this.workspace.lifecycle.refreshPluginCommands(workingDirectory, tabId)
          await Promise.all(transcript.planIds.map((planId) => this.workspace.planStore.hydrateAnnotations(planId)))

          if (environmentRefresh) await environmentRefresh
          if (worktreePath && gitContext && currentResumeTarget()) {
            await this.workspace.lifecycle.hydrateChangedFilesFromDiff(tabId)
          }
        })().catch((error) => console.warn("Session environment refresh failed", error))
      }

      // Joined here rather than beside the transcript: the conversation is
      // already on screen, so this only settles the chrome around it. A failed
      // bind still surfaces to the caller, but it can no longer discard a
      // transcript that loaded successfully.
      const attachFailure = await runtimeAttach
      if (attachFailure) throw attachFailure
    } finally {
      const session = currentResumeTarget()
      if (session) session.loadingHistory = false
    }

    if (intoTabId) requestInputFocus({ tabId })
    track('session_resumed', {})
    return tabId
  }

  /** Compose a fresh session bound to a task. The task target belongs to the
   *  draft until Send creates the session, so leaving the composer does not
   *  leave an empty tab behind. */
  async openTaskSession(task: Task): Promise<void> {
    // The task's own project, not the one on screen: the sidebar spans projects,
    // so the row you clicked is often not in the one the status bar names.
    const cwd = task.projectKey ?? '~'
    // The task's own host, not the focused tab's: the task's path names a
    // folder on the host that holds it. A task in the cloud workspace service
    // files there and runs on an execution host the run picker chooses.
    const taskServerId = this.workspace.tasksStore.get(task.id).serverId ?? undefined
    this.workspace.router.closeGroup('page')
    if (!taskServerId || hostRolesStore.hasExecution(taskServerId)) {
      this.workspace.drafts.openSessionDraft(
        { taskId: task.id, target: this.workspace.router.leadingPane.id, serverId: taskServerId, taskServerId },
        cwd,
      )
      requestInputFocus()
      return
    }
    this.openRepositoryDraft(this.workspace.tasksStore.projectKeyOf(task), { taskId: task.id, taskServerId })
    requestInputFocus()
  }

  private get runOnHosts(): RunOnHost[] {
    return serversStore.executionServers.map((host) => ({
      serverId: host.id,
      online: host.status === 'online',
      managed: hostIsManaged(host),
    }))
  }

  /** Point a new run at another online checkout of its project, when the
   *  run-on rule finds one. A managed host with no checkout is left to the run
   *  picker: moving there is a dispatch the person confirms on Send. */
  moveToRunOnHost(run: RunConfig): void {
    const directory = run.gitContext?.repoRoot ?? run.workingDirectory
    if (!directory || directory === '~') return
    const choice = chooseRunOnHost(
      projectsStore.checkoutsOf(projectsStore.projectKeyFor(run.serverId, directory)),
      this.runOnHosts,
    )
    if (!choice?.path) return
    run.serverId = choice.serverId
    run.taskServerId = choice.serverId
    run.workingDirectory = choice.path
    run.gitContext = null
    run.projectGroupPath = null
  }

  /**
   * A draft for work in a repository no machine was named for — a task whose
   * home is the workspace service, which runs nothing, or the project cloud
   * onboarding ends in (docs/plans/project-model.md §6): it runs in the
   * project's most recently used checkout on a host that is up — in its own
   * worktree only on a shared host (§7) — or, with every checkout off, on the
   * organization's managed host, started if needed, which clones the
   * repository on Send. With neither, the draft names no machine and the run
   * picker says why. A `preferredServerId` — the machine cloud onboarding just
   * chose — is asked first, so a stale checkout elsewhere does not outrank it.
   */
  openRepositoryDraft(
    projectKey: string | null,
    task?: { taskId: string; taskServerId: string },
    preferredServerId?: string,
  ): void {
    const choice = projectKey
      ? chooseRunOnHost(projectsStore.checkoutsOf(projectKey), this.runOnHosts, preferredServerId)
      : null
    const target = this.workspace.router.leadingPane.id
    if (choice?.path) {
      this.workspace.drafts.openSessionDraft({ ...task, target, serverId: choice.serverId }, choice.path)
      return
    }
    const draft = this.workspace.drafts.openSessionDraft({ ...task, target }, choice ? '~' : (projectKey ?? '~'))
    if (choice && projectKey && isRepositoryKey(projectKey)) {
      draft.run.pendingHostDispatch = { serverId: choice.serverId, intent: 'dispatch', repoKey: projectKey }
    }
  }

  /** Jump back to the work happening on a task: focus the most-recently-linked
   *  session if it's open, else resume it from history. The back-link counterpart
   *  to openTaskSession, driven by the persisted task↔session map. */
  async openTaskLinkedSession(task: Task): Promise<void> {
    const links = this.workspace.tasksStore.get(task.id).sessions
    const link = links?.[links.length - 1]
    if (!link?.sessionId) return void this.openTaskSession(task)

    const ownerServerId = await this.workspace.tasksStore.get(task.id).ownerHost()
    if (!ownerServerId) return
    const sessionServerId = serverConnections.resolveId(link.executionServerId ?? ownerServerId)
    const openTab = findOpenTabForSession(
      link.sessionId,
      this.workspace.tabs,
      this.workspace.sessions.byId,
      this.workspace.tabOrder,
      undefined,
      sessionServerId,
    )
    if (openTab) {
      this.workspace.showExplicitSidebarTaskSession(task.id, link.sessionId)
      this.workspace.selectTab(openTab)
    }
    else {
      // The task link stores a session id, not its agent backend. Resolve the
      // indexed record before resuming instead of assigning whichever provider
      // happens to be selected now; loading a Claude transcript through Codex
      // (or vice versa) returns an empty conversation.
      const meta = await readSessionMeta(sessionServerId, link.sessionId)
      if (meta) {
        this.workspace.showExplicitSidebarTaskSession(task.id, link.sessionId)
        await this.resumeSession(meta)
      }
    }
    this.workspace.router.closeGroup('page')
    requestInputFocus()
  }
}
