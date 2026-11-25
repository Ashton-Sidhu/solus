import { hosts } from '../hosts/hosts.svelte'
import type { Session, RunConfig, Message, SessionDescription, SessionMeta } from '@solus/contracts/types'
import type { Via } from '@solus/contracts/analytics-events'
import type { SurfaceContext } from '../app/surface-context.svelte'
import { findOpenTabForSession } from '../../lib/sessionUtils'
import { uuid } from '@solus/contracts/uuid'
import { isChat, NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { projectsStore } from '../projects/projects.store.svelte'
import { serversStore } from '../connections/servers.store.svelte'
import { chooseRunOnHost, type RunOnChoice, type RunOnHost } from '../projects/run-on-rule'
import { hostHasManagedCompute, hostIsCloud } from '../../components/servers/lib/managed-host'
import { isRepositoryKey } from '@solus/contracts/repository-key'
import { isSolusApiId } from '@solus/contracts/uplink'
import { type Task } from '@solus/contracts/task-types'
import { toasts } from '../../lib/toasts'
import { makeSession, makeTab } from './session.factories'
import { worktreeProjectRoot, gitCheckoutFromState, isSolusWorktreePath, sessionProjectRoot } from '@solus/contracts/types'
import { isTaskFolderPath } from '@solus/contracts/codebases'
import { INITIAL_HISTORY_TURNS, prefetchSessionHistoryPage } from '@solus/client-core/session-history-page'
import type { SessionHistoryPageRequest } from '@solus/contracts/session-history'
import { loadSessionTranscript } from './session-transcript'
import { measureOpenStep } from '../../lib/mount-timing'
import { track } from '../../lib/analytics'
import { requestInputFocus } from '../../lib/inputFocus'
import { guessTaskProject } from '../../lib/task-project'
import { serverConnections } from '@solus/client-core/server-connections'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { ownedTaskId } from './session-draft.svelte'
import { type GitRefreshResult } from '../git/session-environment.store.svelte'
import { findLastUserIndex, parentSessionIdOf } from './session.utils'
import { SessionUnavailableError } from './session-errors'
import { sessionListStore, type ListedSession } from './session-list.store.svelte'
import { RUNNER_NOT_HERE_READ_ONLY_REASON } from './machine-references'
import { rememberRoles } from '../sharing/resource-roles'
import { quotedReplyDraft } from '@solus/client-core/quoted-reply'
import { applyWorktreeOfferResolution } from '../../components/conversation/lib/worktree-offer'
import type { SessionEnvironmentWorkspace } from '../git/session-environment.store.svelte'
import type { WorkspaceContext, ForkTabOptions, CreateTabOptions } from './workspace.context.svelte'
import type { OpenTarget } from './routing/location'
import type { SessionDraft } from './session-draft.svelte'
import { adoptGit, checkoutGit, checkoutPlace, chooseCodebase, chooseStart, codebaseOf, dispatchTo, folderLocation, projectHome, refusesCodebase, runHost, startsWorktree, workInStandIn, workingPlace } from './run-location'

/** The workspace members this controller reads or calls, and no others. */
type SessionOpeningWorkspace = Pick<WorkspaceContext,
  | 'activeSession'
  | 'offerSignInAgain'
  | 'activeTab'
  | 'activeTabId'
  | 'addTabToOrder'
  | 'closeTab'
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
  | 'lifecycle'
  | 'openSessionRecord'
  | 'openChatSurface'
  | 'planStore'
  | 'pluginCommands'
  | 'projectPageScope'
  | 'moveChatSurfaceToMain'
  | 'revealConversation'
  | 'runHosts'
  | 'router'
  | 'runFor'
  | 'selectTab'
  | 'serverIdFor'
  | 'sessionFor'
  | 'sessions'
  | 'setActiveTab'
  | 'settings'
  | 'chatSurfaceTabId'
  | 'tabOrder'
  | 'tabs'
  | 'tasksStore'
  | 'ui'
> & SurfaceContext & SessionEnvironmentWorkspace

/**
 * Whether a listed session opens in a tab that reads its copy in Solus Cloud:
 * a session only the cloud lists, or an organization session whose machine is
 * not connected. The mirror holds each published organization session, so no
 * fact of its session repository is needed. A turn that runs now is on a
 * machine this client cannot connect to; the record page shows its rows as
 * they arrive.
 */
function opensFromCloudCopy(listed: ListedSession): boolean {
  return !!listed.cloudOnly || (listed.runnerOffline && listed.status !== 'running')
}

/** The machine that ran a listed session, when this client keeps it: the session repository names it, else the record. */
function machineOf(listed: ListedSession): string | null {
  if (!isSolusApiId(listed.serverId)) return listed.serverId
  return sessionListStore.cloud.headFor(listed.sessionId)?.lastRunServerId ?? listed.awayRunnerServerId ?? null
}

/**
 * Conversations that start from another one: a saved session resumed from
 * disk or another host, a fork, a question asked in a fresh session, and a
 * conversation continued in its own worktree. Each creates the session and
 * then asks the workspace to show it.
 */
/** What a session's first history page is read with: its metadata, or the
 *  same facts a sidebar row already holds. */
type FirstPageFacts = Pick<SessionMeta, 'sessionId' | 'serverId' | 'provider' | 'projectPath' | 'cwd'>

/** Which thread a resume reads and the facts it opens with. */
interface Opening {
  meta: SessionMeta
  handoff: SessionDescription['lineage']
  activeProviderSessionId: string | null
}

/** The caller's facts, before the description answers: the session's own
 *  thread, as the listed record names it. */
function guessedOpening(meta: SessionMeta): Opening {
  return { meta, handoff: null, activeProviderSessionId: meta.sessionId }
}

/** The thread the description names: after a provider handoff it is another
 *  provider's thread, or none yet while the handoff is pending. */
function describedOpening(meta: SessionMeta, { lineage: handoff, meta: describedMeta }: SessionDescription): Opening {
  const activeMember = handoff?.active
  if (activeMember?.providerSessionId) {
    if (!describedMeta) throw new SessionUnavailableError(activeMember.providerSessionId)
    return {
      handoff,
      activeProviderSessionId: activeMember.providerSessionId,
      meta: { ...meta, ...describedMeta, provider: activeMember.provider, sessionId: meta.sessionId, cwd: activeMember.cwd, serverId: meta.serverId },
    }
  }
  if (activeMember) return { handoff, activeProviderSessionId: null, meta: { ...meta, provider: activeMember.provider, cwd: activeMember.cwd } }
  if (!describedMeta) throw new SessionUnavailableError(meta.sessionId)
  return { handoff, activeProviderSessionId: meta.sessionId, meta: { ...meta, ...describedMeta, serverId: meta.serverId } }
}

/** Whether a tab opened on the guess reads the thread the description names. */
function sameOpening(guessed: Opening, described: Opening): boolean {
  return guessed.activeProviderSessionId === described.activeProviderSessionId
    && guessed.meta.provider === described.meta.provider
    && (guessed.meta.cwd || '') === (described.meta.cwd || '')
    && guessed.meta.projectPath === described.meta.projectPath
}

function sessionTitleOf(meta: SessionMeta): string {
  if (meta.customTitle) return meta.customTitle
  if (meta.firstMessage) return meta.firstMessage.length > 80 ? meta.firstMessage.substring(0, 80) : meta.firstMessage
  return meta.slug || 'Resumed'
}

/** What the description adds to a tab opened on the guess. */
function applyDescribedFacts(session: Session, meta: SessionMeta, run: Partial<RunConfig>): void {
  session.title = sessionTitleOf(meta)
  session.titleCustom = !!meta.customTitle
  session.startedBy = meta.startedBy
  session.parentSessionId = parentSessionIdOf(meta)
  session.organizationId = meta.organizationId ?? null
  Object.assign(session.run, run)
  adoptRecordCodebase(session, meta)
}

/** The codebase of a session is a fact of its record (docs/plans/codebases.md
 *  decision 5): the run names it for the views and for each later turn. */
function adoptRecordCodebase(session: Session | undefined, meta: SessionMeta): void {
  if (session) session.run.location = chooseCodebase(session.run.location, meta.codebaseId ?? null)
}

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
    const sourceFolder = checkoutPlace(src?.run)?.path
    const projectRoot = checkoutGit(src?.run)?.repoRoot
      ?? (sourceFolder && sourceFolder !== '~' ? worktreeProjectRoot(sourceFolder) : undefined)
    const draft = this.workspace.drafts.openSessionDraft({ worktreeRequested: true }, projectRoot)
    // Always branch off the project root, even when the source was itself inside
    // a worktree whose checkout the draft would otherwise inherit.
    draft.moveTo(folderLocation(checkoutPlace(draft.run), {
      newWorktree: { baseBranch: null },
      project: projectHome(draft.run),
    }))
    // The move reads the checkout; wait for it as the old explicit read did.
    await this.workspace.config.pendingSessionStartTarget(draft.id)
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
      // A fork runs where its source does until the person picks another
      // host in Run on; that host syncs the source first (plan §10).
      run: {
        ...sourceSession.run,
        modelConfig: { ...sourceSession.run.modelConfig },
        sessionSkills: [...sourceSession.run.sessionSkills],
      },
      pluginCommands: this.workspace.pluginCommands,
      // Both entry points keep the exact source task.
      task: options.task ?? forkTask,
    })

    forkedSession.title = `Fork: ${originalTitle}`
    forkedSession.forkSourceSessionId = sourceSession.id
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
    if (!session?.agentSessionId || checkoutGit(session.run)?.worktreePath || this.workspace.ui.isContinuingInWorktree(tabId)) return

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
      session.run.location = chooseStart(session.run.location, {
        kind: 'worktree',
        path: result.gitContext.worktreePath ?? workingPlace(session.run).path,
        branch: result.gitContext.branch ?? '',
        git: result.gitContext,
      })
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

  /** The first history page `resumeSession` reads for this metadata. */
  private firstPageRequest(meta: FirstPageFacts): SessionHistoryPageRequest & { projectPath: string } {
    const defaultDir = meta.cwd || hosts.get(meta.serverId)?.machineInfo?.homePath || '~'
    return {
      sessionId: meta.sessionId,
      projectPath: meta.projectPath || defaultDir,
      provider: meta.provider ?? this.workspace.settings.activeAgent,
      turnLimit: INITIAL_HISTORY_TURNS,
      deferArtifactHtml: true,
    }
  }

  /** Ask the host for a session's first history page before its tab exists.
   *  The read `resumeSession` makes for the same metadata takes this one, so
   *  the page travels while the tab is created and mounted. */
  prefetchFirstPage(meta: FirstPageFacts, maxAgeMs?: number): void {
    if (!meta.serverId || !hosts.hasExecution(meta.serverId)) return
    const request = this.firstPageRequest(meta)
    if (findOpenTabForSession(meta.sessionId, this.workspace.tabs, this.workspace.sessions.byId,
      this.workspace.tabOrder, request.provider, meta.serverId)) return
    void prefetchSessionHistoryPage(serverConnections.apiFor(meta.serverId), request, maxAgeMs).catch(() => null)
  }

  async resumeSession(
    meta: SessionMeta,
    opts?: {
      background?: boolean
      intoTabId?: string
      /** False once the reader has moved on; the resume then stops before it opens a tab. */
      stillWanted?: () => boolean
      /** The session's description, already read: the tab opens on it. */
      description?: SessionDescription
    },
  ): Promise<string> {
    const openedAt = performance.now()
    // A session ref crossing the client names its host — there is no probe.
    if (!meta.serverId) throw new Error(`Session ${meta.sessionId} names no host`)
    // Every way into a session without a tab comes here: a shared one is no longer new.
    sessionListStore.markOpened({ serverId: meta.serverId, sessionId: meta.sessionId, organizationId: meta.organizationId, publication: meta.publication })
    if (!hosts.hasExecution(meta.serverId)) return this.openFromRecordHome(meta.sessionId, meta.serverId)
    const selectedServerId = meta.serverId
    const selectedApi = serverConnections.apiFor(selectedServerId)
    if (!opts?.intoTabId) this.prefetchFirstPage(meta)
    // `meta.sessionId` is the session id; its lineage names the thread to read
    // (docs/plans/session-identity.md).
    const resumedSessionId = meta.sessionId
    const descriptionStartedAt = performance.now()
    const describing = opts?.description
      ? Promise.resolve(opts.description)
      : selectedApi.describeSession(resumedSessionId).then((description) => {
        measureOpenStep('describeSession', descriptionStartedAt, { sessionId: resumedSessionId })
        return description
      })
    // A resume that stops early never reads the description.
    describing.catch(() => {})
    // A new tab opens on the facts the caller holds, and the description
    // answers beside the history page: waiting for it first cost a round trip
    // before the tab existed. A tab taken over changes in place, so it waits.
    const isGuessed = !opts?.intoTabId && !opts?.description
    const guessedFrom = meta
    const opening = isGuessed ? guessedOpening(meta) : describedOpening(meta, await describing)
    meta = opening.meta
    const { handoff, activeProviderSessionId } = opening
    if (opts?.stillWanted?.() === false) return ''
    const background = opts?.background ?? false
    const intoTabId = opts?.intoTabId
    const provider = meta.provider ?? this.workspace.settings.activeAgent
    const thread = { provider, model: meta.model, reasoningEffort: meta.reasoningEffort }
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
    const defaultDir = meta.cwd || hosts.get(meta.serverId)?.machineInfo?.homePath || '~'
    // The same request the click's prefetch made, so the read below takes it.
    const firstPage = this.firstPageRequest({ ...meta, provider })
    // The folder of the session's project: the record names it for a session in a task folder.
    const workingDirectory = sessionProjectRoot({ cwd: defaultDir, projectRoot: meta.projectRoot })
    const title = sessionTitleOf(meta)

    const hadActiveTab = !!this.workspace.activeTab
    let tabId = intoTabId ?? this.workspace.activeTabId
    const targetTab = intoTabId ? this.workspace.tabs[intoTabId] : this.workspace.activeTab
    const targetSession = intoTabId ? this.workspace.sessionFor(intoTabId) : this.workspace.activeSession
    // A tab that already names this session and shows none of it (it opened
    // from the cloud before a host had it) takes the resume too.
    const canTakeOver = targetTab && targetSession
      && (!targetSession.agentSessionId || (!!intoTabId && targetSession.id === resumedSessionId))
      && targetSession.status !== 'connecting' && targetSession.status !== 'running'
      && targetSession.messages.length === 0
    if (intoTabId && !canTakeOver) {
      throw new Error('A session can only resume into an empty, idle tab')
    }
    const shouldCreateNewTab = !intoTabId && (background || !canTakeOver)
    if (shouldCreateNewTab) {
      const shouldActivate = !background || !hadActiveTab
      const createTabStart = performance.now()
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
        thread,
      })
      measureOpenStep('createTab', createTabStart)
      const session = this.workspace.sessionFor(tabId)
      const tab = this.workspace.tabs[tabId]
      if (!session || !tab) throw new Error('The resumed session tab was not created')
      session.threadProvider = provider
      session.agentSessionId = activeProviderSessionId
      session.handoffPending = !!handoff && !activeProviderSessionId
      session.readOnlyReason = null
      session.loadingHistory = true
      session.title = title
      session.titleCustom = !!meta.customTitle
      session.startedBy = meta.startedBy
      session.parentSessionId = parentSessionIdOf(meta)
      session.organizationId = meta.organizationId ?? null
      if (shouldActivate) {
        if (this.workspace.settings.activeAgent !== provider) {
          this.workspace.config.followActiveSessionAgent(provider)
        }
      }
    } else {
      const session = targetSession!
      session.threadProvider = provider
      session.agentSessionId = activeProviderSessionId
      session.handoffPending = !!handoff && !activeProviderSessionId
      // Taking over an empty tab moves it to the session's host. Safe only
      // because takeover already requires a tab that has started nothing.
      // The session's folder is its own project there, not the tab's old one.
      session.run.location = folderLocation({ serverId: meta.serverId ?? runHost(session.run), path: workingDirectory })
      // The empty tab's draft model is not the session's.
      Object.assign(session.run, this.workspace.config.threadRunFor(thread, session.run))
      session.messages.splice(0, session.messages.length)
      this.workspace.eventReducer.rebuildAgentConversations(session)
      session.readOnlyReason = null
      session.loadingHistory = true
      session.title = title
      session.titleCustom = !!meta.customTitle
      session.startedBy = meta.startedBy
      session.parentSessionId = parentSessionIdOf(meta)
      session.organizationId = meta.organizationId ?? null

      if (!background && !intoTabId) {
        this.workspace.setActiveTab(targetTab!.id)
        if (this.workspace.settings.activeAgent !== provider) {
          this.workspace.config.followActiveSessionAgent(provider)
        }
      }
    }
    this.workspace.adoptSessionId(tabId, resumedSessionId)
    adoptRecordCodebase(this.workspace.sessionFor(tabId), meta)
    if (!background && !intoTabId) this.workspace.revealConversation()
    // A host that is behind gets ready before the person sends (portable-sessions §10).
    sessionListStore.noteSessionMeta(selectedServerId, meta)
    if (meta.execution) this.workspace.sessions.adoptExecution(selectedServerId, resumedSessionId, meta.execution)
    this.workspace.runHosts.opened(tabId)

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
      attachRuntime: true,
    })
      .then(
        (watched) => {
          if (watched.execution) this.workspace.sessions.adoptExecution(selectedServerId, resumedSessionId, watched.execution)
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
      // The working directory of a task folder is a worktree only when its working member is a repository.
      const taskFolderPending = isTaskFolderPath(defaultDir) ? api.taskFolderOf(defaultDir).catch(() => null) : Promise.resolve(null)
      void this.workspace.tasksStore.ensureSessionBinding(resumedSessionId, projectHome(this.workspace.runFor(tabId))?.serverId).catch(() => null)
      // The host sends the folders of a session when the list changes, at a
      // turn start. A session that is opened between turns reads them.
      void api.sessionFolders(resumedSessionId).then((folders) => {
        const opened = currentResumeTarget()
        if (opened) opened.sessionFolders = folders
      }).catch(() => null)
      const transcriptLoad = loadSessionTranscript(this.workspace, {
        sessionId: resumedSessionId,
        loadPath: firstPage.projectPath,
        displayCwd: workingDirectory,
        provider,
        ctx: this.workspace.ctxFor(tabId),
        turnLimit: INITIAL_HISTORY_TURNS,
      })
      if (isGuessed) {
        // The rows wait for the description: they show only the thread it names.
        transcriptLoad.catch(() => {})
        let described: Opening
        try {
          described = describedOpening(guessedFrom, await describing)
        } catch (error) {
          if (currentResumeTarget()) this.workspace.closeTab(tabId)
          throw error
        }
        if (!sameOpening(opening, described)) {
          // Another thread is active now (a provider handoff): open it instead.
          if (currentResumeTarget()) this.workspace.closeTab(tabId)
          return this.resumeSession(guessedFrom, { ...opts, description: await describing })
        }
        const describedSession = currentResumeTarget()
        if (describedSession) applyDescribedFacts(describedSession, described.meta, this.workspace.config.threadRunFor({ provider, model: described.meta.model, reasoningEffort: described.meta.reasoningEffort }, describedSession.run))
      }
      const transcript = await transcriptLoad

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
        measureOpenStep('transcriptApplied', openedAt, { sessionId: resumedSessionId, tabId })
        if (transcript.endsInRefusedLogin) this.workspace.offerSignInAgain(session.id, session)

        void (async () => {
          const [identity, taskFolder] = await Promise.all([identityPending, taskFolderPending])
          const restoredSession = currentResumeTarget()
          if (!restoredSession) return
          // A plain working member has no checkout: its session works through the member, and nothing is missing.
          const standsInForPlainMember = !!taskFolder && !taskFolder.primaryIsWorktree
          const worktreePath = isSolusWorktreePath(defaultDir) && !standsInForPlainMember ? defaultDir : undefined
          // Its files are in the folder that stands in for the member: reads use that folder, and the project stays the member.
          if (taskFolder && standsInForPlainMember) restoredSession.run.location = workInStandIn(restoredSession.run.location, taskFolder.primaryPath)
          this.workspace.lifecycle.recomputeChangedFiles(tabId)
          const gitContext = gitCheckoutFromState(identity, worktreePath)
          restoredSession.run.location = adoptGit(restoredSession.run.location, workingPlace(restoredSession.run), gitContext)
          if (gitContext) restoredSession.readOnlyReason = null
          await this.workspace.environment.registerEnvironment(this.workspace, tabId, worktreePath ?? workingDirectory, gitContext)
          if (!currentResumeTarget()) return
          let environmentRefresh: Promise<GitRefreshResult> | null = null
          // The identity read above already answers whether a worktree is still
          // there: a checkout means it is, null means its branch is gone.
          if (worktreePath && !gitContext) {
            restoredSession.run.location = adoptGit(restoredSession.run.location, workingPlace(restoredSession.run), null)
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

  /**
   * The worktree setup of a session ended, and its run has no checkout: its
   * working folder has no repository. A codebase session of such a folder
   * works in the folder of a task folder that stands in for it
   * (docs/plans/codebases.md §7). No `git_context` event names that folder, so
   * the record of the session does: the run moves there, and the project
   * stays the folder that it stands in for.
   */
  async settleStandIn(sessionId: string): Promise<void> {
    const session = this.workspace.sessions.byId[sessionId]
    if (!session || !startsWorktree(session.run) || checkoutGit(session.run) || !codebaseOf(session.run)) return
    const api = serverConnections.apiFor(runHost(session.run))
    const record = (await api.describeSession(sessionId).catch(() => null))?.meta
    if (!record?.cwd || !isTaskFolderPath(record.cwd)) return
    const taskFolder = await api.taskFolderOf(record.cwd).catch(() => null)
    // The session can end, or get a checkout, while the host answers.
    if (!taskFolder || taskFolder.primaryIsWorktree || this.workspace.sessions.byId[sessionId] !== session || checkoutGit(session.run)) return
    session.run.location = workInStandIn(session.run.location, taskFolder.primaryPath)
  }

  /**
   * Open a session from a home that keeps its record and runs nothing (the
   * Solus API). A session with no host online opens in a tab that shows its
   * copy in Solus Cloud. The record page is for the rest: a turn that runs on
   * a machine this client cannot connect to, a session that is not in this
   * person's list (a link), and a client with no machine for a tab.
   */
  private async openFromRecordHome(sessionId: string, serverId: string): Promise<string> {
    const tabId = await this.openCloudSession(sessionId)
    if (tabId) return tabId
    this.workspace.openSessionRecord(sessionId, serverId)
    return ''
  }

  /**
   * Open a session that no connected host shows, in a tab that reads its copy
   * in Solus Cloud (portable-sessions-cloud §5.5, "The mirror for readers"): a
   * session only the cloud lists, or an organization session whose machine is
   * not connected. The tab opens with no conversation, on the machine that ran
   * the session when this client keeps it (the composer then says that host is
   * offline), else on the Run on host. For a session only the cloud lists, the
   * person can type at once and pick a host in Run on; the host syncs from the
   * cloud, and the conversation shows when it is current. An organization
   * session on a host that is not its machine is read only.
   *
   * Null when no tab opens: the caller shows the session record.
   */
  async openCloudSession(sessionId: string): Promise<string | null> {
    const listed = sessionListStore.listed(sessionId)
    if (!listed || !opensFromCloudCopy(listed)) return null
    const openTabId = findOpenTabForSession(sessionId, this.workspace.tabs, this.workspace.sessions.byId, this.workspace.tabOrder)
    if (openTabId) {
      this.workspace.selectTab(openTabId, 'click')
      return openTabId
    }
    const machineServerId = machineOf(listed)
    const serverId = machineServerId ?? hosts.runOn?.id ?? null
    if (!serverId) {
      if (listed.cloudOnly) toasts.error('Connect a machine to continue this session')
      return null
    }
    const provider = listed.opensWith.provider ?? this.workspace.settings.activeAgent
    const tabId = await this.workspace.createTab(NEW_CHAT_DIRECTORY, {
      activate: true,
      gitContext: null,
      gitInitialization: 'skip',
      skipPluginCommands: true,
      worktreeRequested: false,
      serverId,
      thread: { provider, model: sessionListStore.cloud.modelOf(sessionId) },
    })
    const session = this.workspace.sessionFor(tabId)
    if (!session) return null
    session.threadProvider = provider
    session.agentSessionId = sessionId
    session.title = listed.title ?? 'Session'
    session.organizationId = listed.cloudOnly ? null : listed.organizationId ?? null
    // The reader's role came with the record of the Solus API; the composer asks it of the tab's host.
    if (listed.role) rememberRoles(serverId, [{ kind: 'session', id: sessionId, role: listed.role }])
    this.workspace.adoptSessionId(tabId, sessionId)
    this.workspace.revealConversation()
    // A host that is not the session's machine has no copy of an organization
    // session and syncs none: the tab reads, and asks that host for nothing.
    if (!listed.cloudOnly && !machineServerId) session.readOnlyReason = RUNNER_NOT_HERE_READ_ONLY_REASON
    else this.workspace.runHosts.opened(tabId)
    requestInputFocus({ tabId })
    return tabId
  }

  /**
   * Compose a fresh session bound to a task. The task target belongs to the
   * draft until Send creates the session, so leaving the composer does not
   * leave an empty tab behind.
   *
   * A task belongs to no project, so the draft opens in a guess
   * (`guessTaskProject`): the checkout of a GitHub issue's repository on a
   * connected host, else the project of the input bar. The person can change
   * the project on the draft before Send. With no guess, the draft opens with
   * no folder.
   */
  async openTaskSession(task: Task): Promise<void> {
    this.taskOpenCount++
    const model = this.workspace.tasksStore.get(task.id)
    const taskServerId = model.serverId ?? undefined
    const inputBar = this.workspace.activeCheckout
    const inputBarProjectKey = inputBar ? projectsStore.projectKeyFor(inputBar.serverId, inputBar.projectRoot) : null
    const projectKey = guessTaskProject(
      model,
      (repositoryKey) => projectsStore.checkoutsOf(repositoryKey)
        .some((checkout) => serversStore.readinessFor(checkout.serverId).readiness === 'ready'),
      inputBarProjectKey,
    )
    if (projectKey && taskServerId) {
      // The input bar's project runs where the input bar is; a repository runs
      // where the run-on rule finds its checkout.
      const preferredServerId = projectKey === inputBarProjectKey ? inputBar?.serverId : undefined
      this.openRepositoryDraft(projectKey, { taskId: task.id, taskServerId }, preferredServerId)
    } else {
      this.workspace.drafts.openSessionDraft({ taskId: task.id, taskServerId, target: 'leading', serverId: taskServerId }, '~')
    }
    requestInputFocus()
  }

  private get runOnHosts(): RunOnHost[] {
    return serversStore.executionServers.map((host) => ({
      serverId: host.id,
      online: host.readiness === 'ready',
      cloud: hostIsCloud(host),
      hasManagedCompute: hostHasManagedCompute(host),
    }))
  }

  /** Point a new run at another online checkout of its project, when the
   *  run-on rule finds one. A cloud host with no checkout is left to the run
   *  picker: moving there is a dispatch the person confirms on Send. */
  moveToRunOnHost(run: RunConfig): void {
    const place = checkoutPlace(run)
    const directory = checkoutGit(run)?.repoRoot ?? place.path
    if (!directory || directory === '~') return
    // A chat has no checkout to follow: any host that is up can run it.
    if (isChat(directory)) {
      const host = this.runOnHosts.find((candidate) => candidate.online)
      if (!host) return
      run.location = folderLocation({ serverId: host.serverId, path: NEW_CHAT_DIRECTORY })
      return
    }
    const choice = chooseRunOnHost(
      projectsStore.checkoutsOf(projectsStore.projectKeyFor(place.serverId, directory)),
      this.runOnHosts,
    )
    if (!choice?.path) return
    // A codebase is on every host, so the run keeps it on the host it moves to.
    run.location = folderLocation({ serverId: choice.serverId, path: choice.path }, { codebaseId: codebaseOf(run), noCodebase: refusesCodebase(run) || undefined })
  }

  /**
   * Where work in a repository runs (docs/plans/project-model.md §6): its most
   * recently used checkout on a host that is up, else the organization's
   * cloud host, which has no checkout yet (`path: null`). A
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
    task?: { taskId: string; taskServerId: string },
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
      draft.moveTo(dispatchTo(draft.run.location, choice.serverId, projectKey))
    }
    return draft
  }

  /** Jump back to the work happening on a task: the most-recently-linked
   *  session — focused if it's open, else resumed from history. The back-link
   *  counterpart to openTaskSession; a task nothing has run on gets a draft. */
  async openTaskLinkedSession(task: Task): Promise<void> {
    const opening = ++this.taskOpenCount
    const stillWanted = () => opening === this.taskOpenCount
    const links = this.workspace.tasksStore.get(task.id).sessions
    const link = links?.[links.length - 1]
    if (!link?.sessionId) {
      await this.openTaskSession(task)
      return
    }

    const ownerServerId = await this.workspace.tasksStore.get(task.id).ownerHost()
    if (!ownerServerId || !stillWanted()) return
    const sessionServerId = serverConnections.resolveId(link.executionServerId ?? ownerServerId)
    const openTab = findOpenTabForSession(
      link.sessionId,
      this.workspace.tabs,
      this.workspace.sessions.byId,
      this.workspace.tabOrder,
      undefined,
      sessionServerId,
    )
    if (openTab) this.workspace.selectTab(openTab, 'click')
    else {
      // The task link stores a session id, not its agent backend. Resolve the
      // indexed record before resuming instead of assigning whichever provider
      // happens to be selected now; loading a Claude transcript through Codex
      // (or vice versa) returns an empty conversation.
      const meta = await readSessionMeta(sessionServerId, link.sessionId)
      if (!meta || !stillWanted()) return
      await this.resumeSession(meta, { stillWanted })
    }
    if (stillWanted()) requestInputFocus()
  }
}
