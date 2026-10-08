import type { TaskOpenTrace } from '../../components/session/lib/task-open-timing'
import { hosts } from '../hosts/hosts.svelte'
import type { Session, RunConfig, Message, SessionMeta } from '@solus/contracts/types'
import type { Via } from '@solus/contracts/analytics-events'
import type { SurfaceContext } from '../app/surface-context.svelte'
import { findOpenTabForSession } from '../../lib/sessionUtils'
import { uuid } from '@solus/contracts/uuid'
import { isChat, NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { projectsStore } from '../projects/projects.store.svelte'
import { serversStore } from '../connections/servers.store.svelte'
import { chooseRunOnHost, type RunOnChoice, type RunOnHost } from '../projects/run-on-rule'
import { hostIsManaged } from '../../components/servers/lib/managed-host'
import { isRepositoryKey } from '@solus/contracts/repository-key'
import { type Task } from '@solus/contracts/task-types'
import { toasts } from '../../lib/toasts'
import { makeSession, makeTab } from './session.factories'
import { worktreeProjectRoot, gitCheckoutFromState, isSolusWorktreePath } from '@solus/contracts/types'
import { INITIAL_HISTORY_TURNS } from '@solus/client-core/session-history-page'
import { loadSessionTranscript } from './session-transcript'
import { track } from '../../lib/analytics'
import { requestInputFocus } from '../../lib/inputFocus'
import { serverConnections } from '@solus/client-core/server-connections'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { reviewGuideStore, sessionGuideIdentity } from '../../components/review/review-guide.store.svelte'
import { ownedTaskId } from './session-draft.svelte'
import { type GitRefreshResult } from '../git/session-environment.store.svelte'
import { findLastUserIndex } from './session.utils'
import { runOnModel } from './run-config'
import { requestConversationScrollToBottom } from './session-plan-operations'
import { SessionUnavailableError } from './session-errors'
import { quotedReplyDraft } from '../../lib/quoted-reply'
import { applyWorktreeOfferResolution } from '../../components/conversation/lib/worktree-offer'
import type { SessionEnvironmentWorkspace } from '../git/session-environment.store.svelte'
import type { WorkspaceContext, ForkTabOptions, CreateTabOptions } from './workspace.context.svelte'
import type { OpenTarget } from './routing/location'
import type { SessionDraft } from './session-draft.svelte'

/** The workspace members this controller reads or calls, and no others. */
type SessionOpeningWorkspace = Pick<WorkspaceContext,
  | 'activeSession'
  | 'offerSignInAgain'
  | 'activeTab'
  | 'activeTabId'
  | 'addTabToOrder'
  | 'adoptSessionId'
  | 'apiFor'
  | 'applyRuntimeAttach'
  | 'applyPendingQuestions'
  | 'config'
  | 'createTab'
  | 'ctxFor'
  | 'dispatch'
  | 'drafts'
  | 'environment'
  | 'eventReducer'
  | 'goToTask'
  | 'hasCompanionPanes'
  | 'lifecycle'
  | 'onTaskOpened'
  | 'openSessionRecord'
  | 'openChatSurface'
  | 'planStore'
  | 'pluginCommands'
  | 'moveChatSurfaceToMain'
  | 'revealConversation'
  | 'router'
  | 'runFor'
  | 'selectTab'
  | 'serverIdFor'
  | 'sessionFor'
  | 'sessions'
  | 'setActiveTab'
  | 'settings'
  | 'showExplicitSidebarTaskSession'
  | 'chatSurfaceTabId'
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
  /** Counts task opens. A slow open checks it after each wait, so a task the
   *  reader clicked past cannot take the screen back when its reads land. */
  private taskOpenCount = 0

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
    // out of the copy. The host records the fork when it forks the provider
    // thread, on the first prompt, and its activity row draws the divider.
    const sourceIsRunning = sourceSession.status === 'running' || sourceSession.status === 'connecting'
    const inFlightFrom = sourceIsRunning ? findLastUserIndex(sourceSession.messages) : -1
    const settledMessages = inFlightFrom === -1
      ? sourceSession.messages
      : sourceSession.messages.slice(0, inFlightFrom)
    const copiedMessages: Message[] = settledMessages.map((m) => ({ ...m, id: uuid() }))

    const taskId = ownedTaskId(this.workspace.tasksStore, sourceSession)
    const forkTask: Session['task'] = taskId
      ? { kind: 'existing', taskId }
      : { ...sourceSession.task }
    const forkedSession = makeSession(this.workspace.settings, {
      agentSessionId: sourceSession.agentSessionId,
      forked: true,
      forkExcludeLatestTurn: sourceIsRunning && inFlightFrom !== -1,
      // Source provenance lives on the fork's activity. It is not an identity
      // alias: this fork and its source remain separate sessions.
      forkedFromSessionId: null,
      messages: copiedMessages,
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
      this.workspace.revealConversation()
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

    if (this.workspace.chatSurfaceTabId === sourceTabId) this.workspace.moveChatSurfaceToMain()
    else if (sourceTabId !== this.workspace.activeTabId) this.workspace.selectTab(sourceTabId)

    const taskId = ownedTaskId(this.workspace.tasksStore, sourceSession)
    const forkTabId = await this.forkTab(sourceTabId, {
      activate: false,
      task: taskId ? { kind: 'existing', taskId } : { ...sourceSession.task },
    })
    if (!forkTabId) return
    const forked = this.workspace.sessionFor(forkTabId)!
    forked.prompt.text = draft
    this.workspace.openChatSurface(forked.id)
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
      // The host recorded the move; its activity row draws the divider.
      session.forkedFromSessionId = session.agentSessionId
      session.forked = true
      requestInputFocus()
    } finally {
      // Clear the setup card whether we succeeded (the host's "moved this
      // session" activity now marks completion) or failed (toast already shown). Nothing
      // runs here, so no status_change will clear it for us.
      if (session.statusCard?.id === `continue-worktree-${tabId}`) session.statusCard = null
      this.workspace.ui.endContinueInWorktree(tabId)
    }
  }

  /** Answer the card that offers to move this session into the worktree the
   *  agent works in. The host records the answer and moves the session; the
   *  card and the checkout follow its events. */
  async decideWorktreeOffer(tabId: string, offerId: string, decision: 'switch' | 'keep'): Promise<void> {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    try {
      const resolution = await this.workspace.apiFor(tabId).decideWorktreeOffer(this.workspace.ctxFor(tabId), offerId, decision)
      applyWorktreeOfferResolution(session.messages, offerId, resolution)
      if (resolution.decision === 'switched') {
        void this.workspace.environment.refreshEnvironment(this.workspace, {
          sourceId: tabId,
          level: 'full',
          force: true,
        }).catch(() => null)
      }
    } catch (error) {
      toasts.error("Couldn't answer the worktree offer", { description: error instanceof Error ? error.message : String(error) })
    }
    requestInputFocus()
  }

  async resumeSession(
    meta: SessionMeta,
    opts?: {
      background?: boolean
      intoTabId?: string
      /** False once the reader has moved on; the resume then stops before it opens a tab. */
      stillWanted?: () => boolean
      /** Runs once the new conversation is the destination, before its transcript loads. */
      onShown?: (tabId: string) => void
    },
  ): Promise<string> {
    // A session ref crossing the client names its host — there is no probe.
    if (!meta.serverId) throw new Error(`Session ${meta.sessionId} names no host`)
    // The workspace service keeps the record and no transcript: while the runner
    // is offline the session opens read-only (docs/plans/cloud-service-model.md R8).
    if (!hosts.hasExecution(meta.serverId)) {
      this.workspace.openSessionRecord(meta.sessionId, meta.serverId)
      return ''
    }
    const selectedApi = serverConnections.apiFor(meta.serverId)
    // `meta.sessionId` is the session id; its lineage names the thread to read
    // (docs/plans/session-identity.md).
    const resumedSessionId = meta.sessionId
    const { lineage: handoff, meta: describedMeta } = await selectedApi.describeSession(resumedSessionId)
    const activeMember = handoff?.active
    let activeProviderSessionId: string | null = meta.sessionId
    if (activeMember?.providerSessionId) {
      if (!describedMeta) throw new SessionUnavailableError(activeMember.providerSessionId)
      meta = {
        ...meta,
        ...describedMeta,
        provider: activeMember.provider,
        sessionId: resumedSessionId,
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
    if (opts?.stillWanted?.() === false) return ''
    const background = opts?.background ?? false
    const intoTabId = opts?.intoTabId
    const provider = meta.provider ?? this.workspace.settings.activeAgent
    if (!intoTabId) {
      const openTabId = findOpenTabForSession(
        resumedSessionId,
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
            this.workspace.revealConversation()
          } else this.workspace.selectTab(openTabId, 'click')
        }
        return openTabId
      }
    }
    const defaultDir = meta.cwd || hosts.find(meta.serverId)?.machineInfo?.homePath || '~'
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
      session.handoffPending = !!handoff && !activeProviderSessionId
      session.readOnlyReason = null
      session.loadingHistory = true
      session.title = title
      session.titleCustom = !!meta.customTitle
      session.startedBy = meta.startedBy
      if (shouldActivate) {
        if (this.workspace.settings.activeAgent !== provider) {
          this.workspace.config.followActiveSessionAgent(provider)
        }
      }
    } else {
      const session = targetSession!
      session.run.provider = provider
      session.agentSessionId = activeProviderSessionId
      session.handoffPending = !!handoff && !activeProviderSessionId
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
      session.startedBy = meta.startedBy

      if (!background && !intoTabId) {
        this.workspace.setActiveTab(targetTab!.id)
        if (this.workspace.settings.activeAgent !== provider) {
          this.workspace.config.followActiveSessionAgent(provider)
        }
      }
    }
    this.workspace.adoptSessionId(tabId, resumedSessionId)
    if (!background && !intoTabId) {
      this.workspace.revealConversation()
      opts?.onShown?.(tabId)
    }

    // The watch also attaches to the live runtime, which is what a separate
    // bind used to do after it.
    //
    // It is deliberately not awaited with the transcript below. It supplies only
    // chrome around the conversation — status, rate limits, queued prompts — so
    // joining it to that Promise.all made the spinner outlive the transcript. It
    // is awaited at the end of the resume instead, once the conversation is on
    // screen. Settled rather than left to reject on its own: the join point is
    // several awaits away, so a failure before then would otherwise surface as an
    // unhandled rejection. It is carried and re-thrown at the join instead.
    const runtimeAttach = this.workspace.apiFor(tabId).watchSession({
      sessionId: resumedSessionId,
      attachRuntime: !!activeProviderSessionId,
    })
      .then(
        (watched) => {
          this.workspace.applyRuntimeAttach(tabId, watched.runtime)
          this.workspace.applyPendingQuestions(tabId, watched.pendingQuestions)
          return null
        },
        // With no runtime to attach, a failed watch is not worth failing the
        // resume over.
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
      void this.workspace.tasksStore.ensureSessionBinding(resumedSessionId, this.workspace.runFor(tabId)?.taskServerId).catch(() => null)
      const transcript = await loadSessionTranscript(this.workspace, {
        sessionId: resumedSessionId,
        loadPath: meta.projectPath || defaultDir,
        displayCwd: workingDirectory,
        provider,
        ctx: this.workspace.ctxFor(tabId),
        turnLimit: INITIAL_HISTORY_TURNS,
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
        if (transcript.endsInRefusedLogin) this.workspace.offerSignInAgain(session.id, session)
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
   *  leave an empty tab behind. `role: 'lead'` composes the task's lead, with
   *  the task page beside the draft: the prompt is about the task, so the
   *  record is on screen while it is written (docs/plans/task-conversation.md).
   *  The task surface is in the draft's strip, so Send keeps it. */
  async openTaskSession(task: Task, options: { role?: 'lead' } = {}): Promise<void> {
    this.taskOpenCount++
    this.createTaskDraft(task, options.role, 'leading')
    if (options.role === 'lead') this.openTaskAside(task.id)
    requestInputFocus()
  }

  /** The task page in the companion pane, where there is one. The phone has
   *  one pane and the conversation keeps it; there the page is a tap away on
   *  the session's task chip. */
  private openTaskAside(taskId: string): void {
    if (!this.workspace.hasCompanionPanes) return
    this.workspace.goToTask(taskId, 'click')
  }

  /**
   * Mint a draft bound to a task, in the task's own project and on the task's
   * own host, and point `target` at it when one is given. The task page's
   * conversation composer takes a draft with no pane of its own.
   *
   * The task's project, not the one on screen: the sidebar spans projects, so
   * the row you clicked is often not in the one the status bar names. The
   * task's host, not the focused tab's: the task's path names a folder on the
   * host that holds it. A task in the cloud workspace service files there and
   * runs on an execution host the run picker chooses.
   */
  createTaskDraft(task: Task, role: 'lead' | undefined, target?: OpenTarget): SessionDraft {
    const cwd = task.projectKey ?? '~'
    const taskServerId = this.workspace.tasksStore.get(task.id).serverId ?? undefined
    const binding = { taskId: task.id, taskRole: role, taskServerId }
    let draft: SessionDraft
    if (!taskServerId || hosts.hasExecution(taskServerId)) {
      const options = { ...binding, target, serverId: taskServerId }
      draft = target
        ? this.workspace.drafts.openSessionDraft(options, cwd)
        : this.workspace.drafts.createSessionDraft(options, cwd)
    } else {
      draft = this.openRepositoryDraft(this.workspace.tasksStore.projectKeyOf(task), { ...binding, taskServerId }, undefined, target)
    }
    // A lead starts on the lead model when the user set one. The draft's
    // chip still changes it before Send.
    const leadModel = this.workspace.settings.leadModel
    if (role === 'lead' && leadModel) draft.run = runOnModel(draft.run, leadModel)
    return draft
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
    // A chat has no checkout to follow: any host that is up can run it.
    if (isChat(directory)) {
      const host = this.runOnHosts.find((candidate) => candidate.online)
      if (!host) return
      run.serverId = host.serverId
      run.taskServerId = host.serverId
      run.workingDirectory = NEW_CHAT_DIRECTORY
      run.gitContext = null
      run.projectGroupPath = null
      return
    }
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
   * Where work in a repository runs (docs/plans/project-model.md §6): its most
   * recently used checkout on a host that is up, else the organization's
   * managed host, which has no checkout yet (`path: null`). A
   * `preferredServerId` — the machine cloud onboarding chose — is asked first.
   */
  repositoryRunOn(repositoryKey: string, preferredServerId?: string): RunOnChoice | null {
    return chooseRunOnHost(projectsStore.checkoutsOf(repositoryKey), this.runOnHosts, preferredServerId)
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
   *
   * `target` is the pane the draft opens in, the leading pane by default; null
   * mints the draft without pointing any pane at it.
   */
  openRepositoryDraft(
    projectKey: string | null,
    task?: { taskId: string; taskRole?: 'lead'; taskServerId: string },
    preferredServerId?: string,
    target: OpenTarget | undefined = 'leading',
  ): SessionDraft {
    const choice = projectKey ? this.repositoryRunOn(projectKey, preferredServerId) : null
    const open = (options: CreateTabOptions, cwd: string): SessionDraft => target
      ? this.workspace.drafts.openSessionDraft({ ...options, target }, cwd)
      : this.workspace.drafts.createSessionDraft(options, cwd)
    if (choice?.path) return open({ ...task, serverId: choice.serverId }, choice.path)
    const draft = open({ ...task }, choice ? '~' : (projectKey ?? '~'))
    if (choice && projectKey && isRepositoryKey(projectKey)) {
      draft.run.pendingHostDispatch = { serverId: choice.serverId, intent: 'dispatch', repoKey: projectKey }
    }
    return draft
  }

  /**
   * Open a task as the split view: its lead's conversation in the leading pane
   * and the task page beside it. A task with no lead gets one — a lead draft,
   * whatever else has run on it — so opening a task always means talking to
   * it (docs/plans/task-conversation.md, decision 6). A provider ticket
   * becomes a native task first, because a session binds only to one. The
   * task is open on this client from then on, so the sidebar lists it.
   */
  async openTask(ticket: Task, timing?: TaskOpenTrace): Promise<void> {
    const task = ticket.providerId === 'local'
      ? ticket
      : await this.workspace.tasksStore.get(ticket.id, ticket.projectKey ?? undefined).promote()
    timing?.mark('task_resolved')
    this.workspace.onTaskOpened?.(task.id)
    const links = this.workspace.tasksStore.get(task.id).sessions
    const hasLead = links?.some((candidate) => candidate.role === 'lead') ?? false
    if (hasLead) await this.openTaskLinkedSession(task, timing)
    else {
      await this.openTaskSession(task, { role: 'lead' })
      timing?.shown()
    }
  }

  /** Jump back to the work happening on a task: its lead when it has one, else
   *  the most-recently-linked session — focused if it's open, else resumed from
   *  history. The back-link counterpart to openTaskSession, driven by the
   *  persisted task↔session map. A lead comes with the task page beside it, as
   *  its draft did; a task nothing has run on starts its lead. */
  async openTaskLinkedSession(task: Task, timing?: TaskOpenTrace): Promise<void> {
    const opening = ++this.taskOpenCount
    const stillWanted = () => opening === this.taskOpenCount
    const links = this.workspace.tasksStore.get(task.id).sessions
    const link = links?.find((candidate) => candidate.role === 'lead') ?? links?.[links.length - 1]
    if (!link?.sessionId) {
      await this.openTaskSession(task, { role: 'lead' })
      timing?.shown()
      return
    }

    timing?.mark('owner_lookup_started')
    const ownerServerId = await this.workspace.tasksStore.get(task.id).ownerHost()
    timing?.mark('owner_lookup_finished')
    if (!ownerServerId || !stillWanted()) return
    // A lead comes with its task page beside it. The page opens once the
    // conversation is the destination, so it lands in that conversation's strip.
    const opensTaskAside = link.role === 'lead'
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
      this.workspace.selectTab(openTab, 'click')
      if (opensTaskAside) this.openTaskAside(task.id)
      timing?.shown()
    }
    else {
      // The task link stores a session id, not its agent backend. Resolve the
      // indexed record before resuming instead of assigning whichever provider
      // happens to be selected now; loading a Claude transcript through Codex
      // (or vice versa) returns an empty conversation.
      timing?.mark('session_metadata_started')
      const meta = await readSessionMeta(sessionServerId, link.sessionId)
      timing?.mark('session_metadata_finished')
      if (!meta || !stillWanted()) return
      this.workspace.showExplicitSidebarTaskSession(task.id, link.sessionId)
      // The page opens as soon as the conversation is the destination, so it
      // reads its details while the transcript loads rather than after it.
      let asideOpened = false
      const openAside = () => {
        if (!opensTaskAside || asideOpened || !stillWanted()) return
        asideOpened = true
        this.openTaskAside(task.id)
        timing?.shown()
      }
      await this.resumeSession(meta, { stillWanted, onShown: openAside })
      // A resume that found the conversation already open selects it without
      // showing a new one.
      openAside()
    }
    if (stillWanted()) requestInputFocus()
  }
}
