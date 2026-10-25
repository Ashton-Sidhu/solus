import { attachmentPromptPath, composeAttachmentContext } from './prompt-composer'
import type { IpcContext, Message, Session, OutboundPrompt, PromptImageRef, PromptDelivery } from '@solus/contracts/types'
import type { QueueAttachment } from '@solus/contracts/session-queue'
import { parseReviewCommand, reviewGuideKeyForTarget, reviewGuideTargetId } from '@solus/contracts/review'
import { sendRateLimitedNow } from '../../lib/rate-limit-actions'
import { serversStore } from '../connections/servers.store.svelte'
import { hosts } from '../hosts/hosts.svelte'
import { hostIsManaged } from '../../components/servers/lib/managed-host'
import { type TaskSnapshot } from '@solus/contracts/task-types'
import { toasts } from '../../lib/toasts'
import { ownedTaskId, taskRoleOf } from './session-draft.svelte'
import { nextMsgId } from './session.utils'
import { uuid } from '@solus/contracts/uuid'
import { isSessionBusyStatus, isSteerableStatus, worktreeProjectRoot } from '@solus/contracts/types'
import { requestConversationScrollToBottom } from './session-plan-operations'
import { track } from '../../lib/analytics'
import { requestInputFocus } from '../../lib/inputFocus'
import { serverConnections } from '@solus/client-core/server-connections'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import { localApi } from '@solus/client-core/local-api'
import { sendOutbox, classifySendFailure, type OutboxRecord } from '@solus/client-core/send-outbox'
import { rpcErrorCode } from '@solus/client-core/rpc-error'
import { SEAT_REQUIRED_CODE } from '@solus/contracts/seats'
import { turnRefusalSchema } from '@solus/contracts/organization-scope'
import { seatProviderOf, seatsStore } from '../seats/seats.store.svelte'
import { turnRefusalStore } from '../connections/turn-refusal.store.svelte'
import { clearSettledCards } from './settled-cards'
import { showPendingWorktreeSetup } from './pending-setup-card'
import { hasSessionStarted } from '../../lib/sessionUtils'
import { hasHostCapability } from '@solus/client-core/host-capabilities'
import { delegatedGithubCredential, dispatchRepository } from '../../components/servers/run-on'
import { buildRemoteDispatchCard } from '../../lib/remote-dispatch-card'
import { reviewGuideStore } from '../../components/review/review-guide.store.svelte'
import { directReviewRequest } from '../../components/review/lib/direct-review-command'
import { resolveReviewAgent } from '../../lib/reviewAgent'
import type { WorkspaceContext } from './workspace.context.svelte'
import { checkoutGit, checkoutPlace, isDispatch, openFolder, pendingClone, projectHome, runHost, worktreeBaseBranch } from './run-location'

/** The workspace members this controller reads or calls, and no others. */
type PromptDispatchWorkspace = Pick<WorkspaceContext,
  | 'activeTabId'
  | 'apiFor'
  | 'config'
  | 'ctxFor'
  | 'drafts'
  | 'environment'
  | 'eventReducer'
  | 'focusedSourceId'
  | 'promptComposer'
  | 'serverIdFor'
  | 'sessionFor'
  | 'settings'
  | 'tabIdForSession'
  | 'tabOrder'
  | 'tabs'
  | 'tasksStore'
>

/**
 * Sending a prompt: to a started session, to a draft that becomes one, to a
 * session on another host, or again after a failure. A prompt names its
 * session; the workspace only supplies where that session is showing.
 */
export class PromptDispatch {
  constructor(private readonly workspace: PromptDispatchWorkspace) {}

  private hostDispatchAttempts = new Map<string, number>()

  private startDirectReview(
    tabId: string,
    prompt: string,
    request: NonNullable<ReturnType<typeof directReviewRequest>>,
    projectPath: string,
  ): void {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    const sentAt = Date.now()
    const branch = this.workspace.environment.environmentFor(session.run).branch ?? 'detached'
    const reviewAgent = resolveReviewAgent(this.workspace.settings)
    const reviewGuideRef = {
      target: request.target,
      key: reviewGuideKeyForTarget(request.target, branch, session.agentSessionId ? session.id : null),
      ...reviewAgent,
    }
    session.messages.push({
      id: nextMsgId(),
      role: 'user',
      content: prompt,
      timestamp: sentAt,
    })
    session.messages.push({
      id: nextMsgId(),
      role: 'assistant',
      content: '',
      reviewGuideRef,
      timestamp: sentAt + 1,
    })
    session.status = 'running'
    session.currentActivity = 'Preparing review...'
    session.currentTurnStartedAt = sentAt
    if (session.messages.length === 2 && !session.titleCustom) {
      session.title = prompt.length > 80 ? prompt.substring(0, 80) : prompt
    }
    session.prompt.attachments = []
    session.prompt.planRefs = []
    session.prompt.workRefs = []
    session.prompt.sessionRefs = []
    this.workspace.eventReducer.closeAgentConversationTurn(session)

    const serverId = this.workspace.serverIdFor(tabId)
    const targetId = reviewGuideTargetId(request.target)
    const unsubscribe = serverConnections.eventsFor(serverId).subscribe(
      'review.guideStatusChanged',
      (event) => {
        if (reviewGuideTargetId(event.target ?? request.target) !== targetId) return
        if (event.status === 'queued' || event.status === 'generating') {
          if (session.currentTurnStartedAt === sentAt) {
            session.status = 'running'
            session.currentActivity = event.step === 'writing'
              ? 'Writing review...'
              : event.step === 'analyzing'
                ? 'Analyzing changes...'
                : 'Preparing review...'
          }
          return
        }
        if (session.currentTurnStartedAt === sentAt) {
          session.status = 'completed'
          session.currentActivity = ''
        }
        unsubscribe()
      },
    )
    const repoRoot = worktreeProjectRoot(checkoutGit(session.run)?.repoRoot ?? projectPath)
    void reviewGuideStore.generate(
      this.workspace.apiFor(tabId),
      serverId,
      this.workspace.ctxFor(tabId),
      { repoRoot, key: reviewGuideRef.key, target: request.target },
      { ...reviewAgent, ...request, reportSessionLifecycle: true },
    ).catch((error) => {
      unsubscribe()
      if (session.currentTurnStartedAt === sentAt) {
        session.status = 'failed'
        session.currentActivity = ''
      }
      toasts.error('Review guide generation failed', {
        description: error instanceof Error ? error.message : String(error),
      })
    })
    requestConversationScrollToBottom(tabId)
  }

  promptTab(tabId: string, options: { prompt: string; displayPrompt: string; clientPromptId?: string; delivery?: PromptDelivery; queueAttachments?: QueueAttachment[]; queueAttachmentContext?: string; imageAttachments?: Array<{ mimeType: string; dataUrl: string }>; imageAttachmentRefs?: PromptImageRef[]; taskId?: string; taskRole?: 'lead'; goalObjective?: string }): void {
    const api = this.workspace.apiFor(tabId)
    const promptSession = this.workspace.sessionFor(tabId)
    const watchedSessionId = promptSession?.id
    if (!promptSession || !watchedSessionId) return
    // Durability before dispatch (dispatch-client step 6): the send is queued
    // on the session's host before the wire is trusted with it. Acceptance
    // removes it; a dead transport leaves it for the drain.
    const outboxServerId = runHost(promptSession.run)
    if (options.clientPromptId) {
      sendOutbox.enqueue(outboxServerId, {
        clientPromptId: options.clientPromptId,
        sessionId: watchedSessionId,
        text: options.displayPrompt,
        enqueuedAt: Date.now(),
        payload: {
          prompt: options.prompt,
          displayPrompt: options.displayPrompt,
          delivery: options.delivery,
          imageAttachments: options.imageAttachments,
          imageAttachmentRefs: options.imageAttachmentRefs,
          queueAttachments: options.queueAttachments,
          queueAttachmentContext: options.queueAttachmentContext,
        },
      })
    }
    // The host's prompt handler also makes its sender a watcher before the run
    // can publish, so the prompt does not wait for this reply. The watch goes
    // on the wire first, for a host that predates that rule.
    void api.watchSession({ sessionId: watchedSessionId }).catch((error) => {
      console.warn('[Solus] Session watch failed; the prompt still sends.', error)
    })
    // A run that will branch a new worktree already has its base branch, which
    // only a Git answer for its folder sets. The host reads the rest of the
    // checkout itself, so the send does not wait for a refresh in flight.
    const startTarget = worktreeBaseBranch(promptSession.run) ? null : this.workspace.config.pendingSessionStartTarget(tabId)
    Promise.resolve(startTarget)
      .then(async () => {
        if (!options.taskId) return
        const recordActivity = this.workspace.tasksStore.get(options.taskId).recordActivity()
          .catch((error) => {
            console.warn('[Solus] Task activity update failed; the prompt will still send.', error)
          })
        // A dispatched run ships a task snapshot, which must show the task the
        // activity reopened. Other prompts do not read the task's status.
        if (isDispatch(promptSession.run)) await recordActivity
      })
      .then(() => this.resolveTaskOnItsHost(tabId, options))
      .then(async (resolved) => {
        const ctx = await this.sendContext(tabId)
        // Guard: the tab may have closed while the steps above ran. If so, skip
        // submission to avoid a phantom run that can never be cancelled.
        const session = this.workspace.sessionFor(tabId)
        if (!session) return
        return api.prompt(ctx, resolved)
          .then(() => {
            // The host accepted the prompt: its durable copy has done its job.
            if (options.clientPromptId) sendOutbox.remove(outboxServerId, options.clientPromptId)
          })
      })
      .catch((err: Error) => {
        const session = this.workspace.sessionFor(tabId)
        if (options.clientPromptId) {
          if (classifySendFailure(err) === 'transient') {
            // The transport died under the send: the outbox entry stays for
            // the drain, and the pending bubble keeps standing — "failed"
            // would be a lie about a message that will still deliver.
            return
          }
          // The host answered "no": the in-session failed prompt owns the
          // retry UX, so the durable copy retires with the error shown there.
          sendOutbox.remove(outboxServerId, options.clientPromptId)
          const outbound = session?.outboundPrompts.find(
            (prompt) => prompt.clientPromptId === options.clientPromptId,
          )
          if (outbound) {
            outbound.state = 'failed'
            outbound.error = err.message
          }
        }
        if (session) {
          this.workspace.eventReducer.handleError(session.id, { message: err.message, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 })
          // No seat, no turn (Step 2 plan §3.3): the connect card stands in this
          // conversation; the failed bubble keeps the retry.
          const seatProvider = seatProviderOf(session.run.provider)
          if (rpcErrorCode(err) === SEAT_REQUIRED_CODE && seatProvider) {
            seatsStore.noteRefusal(runHost(session.run), session.id, seatProvider)
          }
          // The organization model refused the turn (organization-vms §4): nothing ran,
          // so the draft goes back to the composer for the retry once the cause is fixed.
          const refusal = turnRefusalSchema.safeParse(rpcErrorCode(err))
          if (refusal.success && !session.prompt.text) {
            session.prompt.text = options.displayPrompt || options.prompt
          }
          // The card says which organization the turn needs and what to do; only this client sees it.
          if (refusal.success) turnRefusalStore.note({ serverId: runHost(session.run), sessionId: session.id, code: refusal.data, message: err.message })
        }
      })
  }

  /** Replay one drained outbox record through the live prompt path. The tab
   *  must still be mounted — a queued send for a closed conversation is
   *  abandoned work, not a surprise message. */
  async redeliverOutboxPrompt(serverId: string, record: OutboxRecord): Promise<void> {
    const tabId = this.workspace.tabIdForSession(record.sessionId)
    if (!tabId || !record.payload) {
      sendOutbox.remove(serverId, record.clientPromptId)
      return
    }
    const result = await this.workspace.apiFor(tabId).prompt(await this.sendContext(tabId), {
      prompt: record.payload.prompt,
      displayPrompt: record.payload.displayPrompt || record.text,
      clientPromptId: record.clientPromptId,
      delivery: record.payload.delivery === 'steer' ? 'steer' : 'queue',
      imageAttachments: record.payload.imageAttachments,
      imageAttachmentRefs: record.payload.imageAttachmentRefs,
      queueAttachments: record.payload.queueAttachments,
      queueAttachmentContext: record.payload.queueAttachmentContext,
    })
    if (result.disposition === 'duplicate') return
  }

  /**
   * The context of one prompt send to a tab's host. A Run on send also carries
   * the client machine's GitHub credential for the clone. Every send reads it
   * again from this device's own host — the first send, a retry, and an outbox
   * redelivery — because it is never stored: not in the outbox, not in the
   * session. When the read fails, the send goes without it and the run host
   * uses its own token.
   */
  private async sendContext(tabId: string): Promise<IpcContext> {
    const ctx = this.workspace.ctxFor(tabId)
    const session = this.workspace.sessionFor(tabId)
    // `ctxFor` builds a new repository object for each call, so the credential
    // stays on this one context.
    if (!ctx.session.repository || !session) return ctx
    const credential = await delegatedGithubCredential(runHost(session.run))
    if (credential) ctx.session.repository.credential = credential
    return ctx
  }

  /**
   * Bind the selected task on the host that owns it — before the first prompt
   * leaves. A session with no task selected stays without one: a session never
   * makes a task of its own (docs/plans/task-conversation.md, decision 8).
   *
   * The two hosts are the same machine for ordinary work, and this is a no-op
   * beyond one extra call. They differ for a dispatch: the task lives on the
   * host that holds the project, not on the machine the user borrowed to run
   * an agent.
   *
   * A failure here is not allowed to swallow the prompt. The send then runs
   * with no task, except for a lead, which exists only as its task's lead.
   */
  private async resolveTaskOnItsHost<T extends { taskId?: string; taskRole?: 'lead'; taskSnapshot?: TaskSnapshot }>(
    tabId: string,
    options: T,
  ): Promise<T> {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return options
    // A session with a provider thread is past its first dispatch: its task is
    // bound already. A dispatched one still needs its packet re-shipped: the
    // execution host cannot read the task host's store, so every prompt
    // carries the task's live state.
    if (session.agentSessionId) {
      return isDispatch(session.run) ? this.attachTaskSnapshot(session, options) : options
    }
    if (!options.taskId) return options
    const project = projectHome(session.run)
    try {
      const { task, snapshot } = await this.workspace.tasksStore.prepareForSession(project.serverId, {
        taskId: options.taskId,
        projectKey: project.path,
        includeSnapshot: isDispatch(session.run),
        role: options.taskRole,
      })
      if (!task) return options
      let preparedSnapshot = snapshot
      if (session.prReview) {
        try {
          await this.workspace.tasksStore.get(task.id).link({
            kind: 'pr',
            targetScope: task.projectKey ?? project.path,
            targetKey: String(session.prReview.number),
            title: `#${session.prReview.number} ${session.prReview.title}`,
            automatic: true,
          })
          // The first snapshot was read in the binding transaction, before the
          // PR edge existed. A dispatched run must ship the linked version.
          if (snapshot) {
            preparedSnapshot = await this.workspace.tasksStore.get(task.id).dispatchSnapshot(projectHome(session.run).serverId)
          }
        } catch (error) {
          console.warn('[Solus] PR task link failed; the prompt will still send.', error)
        }
      }
      // The snapshot tells the execution host that the task lives elsewhere.
      return preparedSnapshot ? { ...options, taskSnapshot: preparedSnapshot } : options
    } catch (error) {
      // A lead exists only as its task's lead: a run that went ahead unbound
      // would be an ordinary session with the lead's prompt. The refusal — the
      // task already has a lead, or its host is away — fails the send instead,
      // and the transcript shows why.
      if (options.taskRole === 'lead') throw error
      console.warn('[Solus] Task host binding failed; the prompt will run without a task.', error)
      return { ...options, taskId: undefined }
    }
  }

  /** Re-ship a dispatched session's task state with a follow-up prompt. Best
   *  effort: a failure means the packet goes stale for one turn, never that the
   *  send is swallowed. */
  private async attachTaskSnapshot<T extends { taskId?: string; taskSnapshot?: TaskSnapshot }>(
    session: Session,
    options: T,
  ): Promise<T> {
    const taskId = ownedTaskId(this.workspace.tasksStore, session)
    if (!taskId) return options
    try {
      const snapshot = await this.workspace.tasksStore
        .get(taskId)
        .dispatchSnapshot(projectHome(session.run).serverId)
      return snapshot ? { ...options, taskId, taskSnapshot: snapshot } : options
    } catch (error) {
      console.warn('[Solus] Task snapshot refresh failed; the packet stays stale this.workspace turn.', error)
      return options
    }
  }

  /** Sends to the active tab unless `tabId` targets another one (the split
   *  conversation pane's composer). */
  sendMessage(
    prompt: string,
    projectPath?: string,
    tabId?: string,
    delivery: PromptDelivery = 'steer',
  ): boolean {
    // A legacy caller can still send before the draft pane has promoted itself.
    // Promote that same draft here; never mint a session from a second set of
    // defaults, or this path would disagree with the visible composer.
    const focusedSourceId = this.workspace.focusedSourceId
    if (!tabId && focusedSourceId && this.workspace.drafts.sessionDrafts.has(focusedSourceId)) {
      const targetTabId = this.workspace.drafts.startSessionDraft(focusedSourceId)
      if (!targetTabId) return false
      return this.sendMessage(prompt, projectPath, targetTabId, delivery)
    }
    if (!tabId && this.workspace.tabOrder.length === 0) return false
    const targetTabId = tabId ?? this.workspace.activeTabId
    const tab = this.workspace.tabs[targetTabId]
    const session = this.workspace.sessionFor(targetTabId)
    if (!tab || !session) return false
    if (session.status === 'connecting') return false
    if (session.readOnlyReason) return false

    // On the web a run with no machine — none paired yet, or only the workspace
    // service, which runs no agents — asks for a host instead of sending.
    if (
      localApi.getPlatform() === 'web'
      && !hosts.hasExecution(runHost(session.run))
      && !pendingClone(session.run)
    ) {
      window.dispatchEvent(new CustomEvent('solus:open-server-connect'))
      toasts.info('Connect a host to start working')
      return false
    }

    const resolvedPath = projectPath || checkoutPlace(session.run).path
    if (
      !pendingClone(session.run)
      && runHost(session.run) !== LOCAL_SERVER_ID
      && !resolvedPath
    ) {
      toasts.error('Choose a project on the remote host before sending')
      return false
    }

    clearSettledCards(session)

    if (needsHostPreparation(session)) {
      // Connecting a host can take several seconds. The turn starts when the user
      // sends, not when that preparation eventually produces a provider echo.
      session.currentTurnStartedAt = Date.now()
      session.status = 'connecting'
      void this.prepareHostDispatchAndSend(targetTabId, prompt, resolvedPath, delivery)
      return true
    }
    return this.dispatchPrompt(targetTabId, session, prompt, resolvedPath, delivery)
  }

  /** The send itself, once the run's host can take it. */
  private dispatchPrompt(
    targetTabId: string,
    session: Session,
    prompt: string,
    resolvedPath: string,
    delivery: PromptDelivery,
  ): boolean {
    if (session.outboundPrompts.some((entry) => entry.kind === 'provider_switch')) delivery = 'queue'
    const isBusy = isSessionBusyStatus(session.status) || !!session.queueHeld || session.outboundPrompts.some((entry) => !!entry.queueId)
    const input = session.prompt
    const directReview = directReviewRequest(prompt)
    if (directReview) {
      if (isBusy) {
        toasts.info('Wait for the current turn to finish before starting a review')
        return false
      }
      this.startDirectReview(targetTabId, prompt, directReview, resolvedPath)
      return true
    }
    if (parseReviewCommand(prompt)) {
      toasts.error('A pull request URL is required', {
        description: 'Use /review:pr followed by a GitHub pull request URL.',
      })
      return false
    }

    const fullPrompt = this.workspace.promptComposer.compose(prompt, input, session)
    // Capture image blocks before the input's attachments are cleared below.
    // `imageAttachments` stays local — the queued-prompt chip renders from it.
    const imageAttachments = this.workspace.promptComposer.composeImages(input)
    const runServerId = serverConnections.resolveId(runHost(session.run))
    const imagePayload = this.workspace.promptComposer.composeImagePayload(
      input,
      runServerId,
      hasHostCapability(serverConnections.cachedCapabilitiesFor(runServerId), 'promptImageRefs'),
    )
    // Not `nextMsgId()`: that counter restarts on every reload and on every
    // device, and this id keys the durable outbox and the host's dedupe.
    const clientPromptId = uuid()
    // The whole attachment, not four of its fields. The transcript renders these
    // again — a browser annotation as its marks and capture, a file as something
    // openable — and every one of those needs `id`, `path`, the host path behind
    // the picture, and `designData`. Flattening dropped all four while keeping
    // `dataUrl`, the only large member, so the sent bubble showed an annotation
    // stripped of its marks, its element and its frame.
    const attachments = input.attachments.length > 0
      ? input.attachments.map((attachment) => ({ ...attachment }))
      : undefined
    const planRefs = input.planRefs.length > 0 ? [...input.planRefs] : undefined
    const workRefs = input.workRefs.length > 0 ? [...input.workRefs] : undefined
    const sessionRefs = input.sessionRefs.length > 0 ? [...input.sessionRefs] : undefined

    const title = session.messages.length === 0 && !session.titleCustom
      ? (prompt.length > 80 ? prompt.substring(0, 80) : prompt)
      : session.title

    if (resolvedPath !== checkoutPlace(session.run).path) {
      session.run.location = openFolder(session.run.location, { serverId: runHost(session.run), path: resolvedPath }, { keepProject: isDispatch(session.run) })
    }
    session.run.provider = session.run.provider ?? this.workspace.settings.activeAgent
    // The first prompt starts the thread on the provider it carries; after that
    // only the host moves the thread (plans/021).
    if (!isBusy && !session.agentSessionId && !session.handoffPending) session.threadProvider = session.run.provider

    const isFirstMessage = session.messages.length === 0 || (session.forked && !session.forkedFromSessionId)
    const agent = session.run.provider ?? this.workspace.settings.activeAgent
    if (isFirstMessage) track('conversation_started', { agent })
    track('message_sent', { agent, is_first_message: isFirstMessage, permission_mode: session.run.permissionMode, attachment_count: input.attachments.length, image_count: imageAttachments.length, plan_ref_count: planRefs?.length ?? 0, work_ref_count: workRefs?.length ?? 0, session_ref_count: sessionRefs?.length ?? 0, has_slash_command: prompt.startsWith('/'), delivery: isBusy ? (isSteerableStatus(session.status) && delivery === 'steer' ? 'steer' : 'queue') : 'immediate', is_remote_host: runHost(session.run) !== LOCAL_SERVER_ID })

    if (isBusy) {
      session.title = title
      const outbound: OutboundPrompt = {
        clientPromptId,
        text: prompt,
        state: isSteerableStatus(session.status) && delivery === 'steer' ? 'steering' : 'queueing',
        enqueuedAt: Date.now(),
      }
      if (imageAttachments.length > 0) outbound.images = imageAttachments
      if (attachments) outbound.attachments = attachments
      if (planRefs) outbound.planRefs = planRefs
      if (workRefs) outbound.workRefs = workRefs
      if (sessionRefs) outbound.sessionRefs = sessionRefs
      session.outboundPrompts.push(outbound)
      input.attachments = []
      input.planRefs = []
      input.workRefs = []
      input.sessionRefs = []
    } else {
      const sentAt = session.currentTurnStartedAt ?? Date.now()
      const userMsg: Message = {
        id: clientPromptId,
        role: 'user' as const,
        content: prompt,
        timestamp: sentAt,
        clientPromptId,
        attachments,
        planRefs,
        workRefs,
        sessionRefs,
      }
      session.currentTurnStart = isFirstMessage ? 'fresh' : 'follow_up'
      session.currentTurnStartedAt = sentAt
      session.currentActivity = session.currentTurnStart === 'fresh'
        ? 'Starting session...'
        : 'Resuming...'
      session.status = 'connecting'
      showPendingWorktreeSetup(session)
      session.title = title
      input.attachments = []
      input.planRefs = []
      input.workRefs = []
      input.sessionRefs = []
      session.progress = null
      session.retryAttempt = 1
      session.terminalFailure = null
      session.messages.push(userMsg)
      // Cut the turn boundary immediately; the host confirmation reconciles
      // this optimistic message without opening the turn again.
      this.workspace.eventReducer.closeAgentConversationTurn(session)
    }

    const promptTaskId = ownedTaskId(this.workspace.tasksStore, session)
    this.promptTab(targetTabId, {
      prompt: fullPrompt,
      displayPrompt: prompt,
      queueAttachments: attachments?.map((attachment) => ({ id: attachment.id, name: attachment.name, type: attachment.type,
        hostPath: attachmentPromptPath(attachment, runHost(session.run)) || undefined,
        dataUrl: attachment.type === 'image' && !attachment.hostPath ? attachment.dataUrl : undefined, mimeType: attachment.mimeType, size: attachment.size,
        context: attachment.type === 'image' ? undefined : composeAttachmentContext([attachment], runHost(session.run)) })),
      queueAttachmentContext: attachments ? composeAttachmentContext(attachments.filter((item) => item.type !== 'image'), runHost(session.run)) : undefined,
      clientPromptId,
      delivery,
      imageAttachments: imagePayload.inline,
      imageAttachmentRefs: imagePayload.refs,
      taskId: promptTaskId,
      taskRole: taskRoleOf(session.task),
      goalObjective: isFirstMessage ? session.pendingGoalObjective ?? undefined : undefined,
    })
    requestConversationScrollToBottom(targetTabId)
    return true
  }

  private async prepareHostDispatchAndSend(
    tabId: string,
    prompt: string,
    resolvedPath: string,
    delivery: PromptDelivery,
  ): Promise<void> {
    const tab = this.workspace.tabs[tabId]
    const session = this.workspace.sessionFor(tabId)
    if (!tab || !session) return
    const location = session.run.location
    const clone = pendingClone(session.run)
    const serverId = runHost(session.run)
    const attempt = (this.hostDispatchAttempts.get(tabId) ?? 0) + 1
    this.hostDispatchAttempts.set(tabId, attempt)
    const superseded = () =>
      this.hostDispatchAttempts.get(tabId) !== attempt || this.workspace.sessionFor(tabId) !== session
    const bailIfStale = (): boolean => {
      if (superseded()) return true
      if (session.status === 'connecting' && session.run.location === location) return false
      // The user withdrew this send (Stop, or a replaced pick); this attempt still
      // owns the tab's dispatch UI, so it also cleans it up and returns the prompt.
      session.statusCard = null
      if (!session.prompt.text) session.prompt.text = prompt
      return true
    }
    let activeStep: 'connection' | 'repository' = 'connection'
    // Named from the connection registry rather than from a label copied at pick
    // time, which goes stale the moment that host is renamed. Falls back to the
    // id, which is all there is to say about a host that cannot be resolved.
    let hostLabel = serverId
    requestConversationScrollToBottom(tabId)

    try {
      // The host copies the repository when the prompt arrives (docs/run-on.md),
      // so the client only checks that there is one it can name.
      if (clone && !dispatchRepository(clone)) {
        activeStep = 'repository'
        throw new Error('This repository does not have a cloneable remote.')
      }
      // A stopped Cloud host is started first (docs/plans/project-model.md §6):
      // the client dials only a host the directory says is ready.
      if (hostIsManaged(serversStore.hostFor(serverId)) && serversStore.readinessFor(serverId).readiness !== 'ready') {
        session.statusCard = buildRemoteDispatchCard({ tabId, hostLabel: serversStore.hostFor(serverId)?.label ?? hostLabel, phase: 'connecting' })
        const started = await serversStore.startManagedHost(serverId)
        if (bailIfStale()) return
        if (!started) throw new Error('The Cloud host did not start. Try again, or choose another host.')
      }
      // Synchronous and idempotent, so the card below still paints before any
      // awaiting — and it is what knows this host's name.
      const connection = serverConnections.ensure(serverId)
      hostLabel = connection.target.label
      session.statusCard = buildRemoteDispatchCard({ tabId, hostLabel, phase: 'connecting' })
      // Every connection reads the host's capabilities first, so this waits for
      // the connection without a request of its own.
      await serverConnections.capabilitiesFor(serverId)
      if (bailIfStale()) return
      // A clone is made by the host when the prompt arrives; its card takes over
      // from this step. A folder is already on disk over there.
      session.statusCard = buildRemoteDispatchCard({ tabId, hostLabel, phase: clone ? 'repository' : 'ready' })
      session.status = 'idle'
      this.dispatchPrompt(tabId, session, prompt, resolvedPath, delivery)
    } catch (error) {
      if (superseded()) return
      const message = error instanceof Error ? error.message : String(error)
      session.status = 'idle'
      session.currentTurnStartedAt = null
      session.statusCard = buildRemoteDispatchCard({
        tabId,
        hostLabel,
        phase: activeStep === 'connection' ? 'connecting' : 'repository',
        error: { step: activeStep, message },
      })
      if (!session.prompt.text) session.prompt.text = prompt
      requestInputFocus({ tabId })
    }
  }

  retryLastMessage(tabId: string, recoverSetup = false): void {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    if (session.status === 'connecting') return
    if (session.readOnlyReason) return

    if (session.status === 'rate_limited' && session.outboundPrompts.some((prompt) => prompt.state === 'queued' && prompt.reason === 'rate_limit')) {
      sendRateLimitedNow(this.workspace.apiFor(tabId), this.workspace.ctxFor(tabId), true, (err) => this.workspace.eventReducer.handleError(session.id, err))
      return
    }

    const lastUserMsg = [...session.messages].reverse().find((m) => m.role === 'user')
    if (!lastUserMsg && !recoverSetup) return

    const lastMsg = session.messages[session.messages.length - 1]
    if (lastMsg?.role === 'system' && lastMsg.content.startsWith('Error:')) {
      session.messages.splice(session.messages.length - 1, 1)
    }

    session.status = 'connecting'
    session.currentTurnStart = 'follow_up'
    session.currentTurnStartedAt = Date.now()
    session.currentActivity = 'Resuming...'
    session.run.provider = session.run.provider ?? this.workspace.settings.activeAgent
    session.progress = null
    session.retryAttempt = (session.retryAttempt ?? 1) + 1
    session.terminalFailure = null

    // The host launches the retry from this context, so a Run on retry carries the credential again.
    const retry = this.sendContext(tabId)
      .then((ctx) => this.workspace.apiFor(tabId).retry(ctx, { prompt: lastUserMsg?.content ?? '' }))

    retry.catch((err: Error) => {
      this.workspace.eventReducer.handleError(session.id, { message: err.message, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 })
    })
  }
}

/**
 * Whether Send must prepare the run's host before the first prompt goes out: a
 * clone to make, or a remote host that is not online yet — a stopped Cloud host
 * to start, or one still connecting. Nothing about this is stored in the run.
 */
function needsHostPreparation(session: Session): boolean {
  if (pendingClone(session.run)) return true
  // A started session's prompts wait in the outbox for its host instead.
  if (hasSessionStarted(session)) return false
  const serverId = runHost(session.run)
  const host = serversStore.hostFor(serverId)
  return !!host && !host.local && serversStore.readinessFor(serverId).readiness !== 'ready'
}
