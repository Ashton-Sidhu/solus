import type { EnrichedError, GitState, Message, Session, ThreadGoal, WireNormalizedEvent } from '@solus/contracts/types'
import { existingTaskId, taskBindingSessionId } from './session-draft.svelte'
import { encodePathAsFolder } from '@solus/contracts/types'
import { uuid } from '@solus/contracts/uuid'
import type { SettingsContext } from '../app/settings.context.svelte'
import type { PlanStore } from '../plans/plan.store.svelte'
import type { WorksStore } from '../works/works.store.svelte'
import type { TasksStore } from '../tasks/tasks.store.svelte'
import type { AutomationsStore } from '../automations/automations.store.svelte'
import type { TabRegistry } from './tab-registry.svelte'
import type { WorkStreamTracker } from './work-stream-tracker.svelte'
import { AgentConversationTracker } from './agent-conversation-tracker.svelte'
import { AGENT_INTERRUPT_NOTICE, findLastUserIndex, isAgentNotice, normalizeTodoStatus, nextMsgId, progressFromTodos, removeAssistantPlanDuplicate, toPermissionRequest, toQuestionRequest } from './session.utils'
import { mergeRemoteDispatchProgress } from '../../lib/remote-dispatch-card'

export interface SessionEventReducerDeps {
  registry: TabRegistry
  settings: SettingsContext
  planStore: PlanStore
  worksStore: WorksStore
  tasksStore: TasksStore
  automationsStore: AutomationsStore
  workStreamTracker: WorkStreamTracker
  /** Is this conversation on screen anywhere — the active tab, or a chat pinned
   *  into a companion pane? Several tabs may watch one session; one of them
   *  being visible is what makes the session read. */
  isSessionVisible(sessionId: string): boolean
  addChangedFilesFromMessage(sessionId: string, message: Message): void
  refreshTurnSnapshots(sessionId: string): void
  setGitStatus(cwd: string, status: GitState | null): void
  playNotificationIfHidden(): void
  closePlanModal(): void
  onTurnSettled(sessionId: string, cwd: string | null): void
  onGoalDefined?(sessionId: string): void
  applyGoalUpdated?(sessionId: string, goal: ThreadGoal): boolean
  applyGoalCleared?(sessionId: string, threadId: string): void
  onSessionInitialized?(sessionId: string): void
  handlePendingInputSync(session: Session, events: Extract<WireNormalizedEvent, { type: 'pending_input_sync' }>['pendingInputEvents']): void
  log(eventType: string, session: Session): void
}

/**
 * Applies a conversation's events to it.
 *
 * Everything here is addressed by **session id**, never by tab. A session is
 * what has messages, a status and a stream; a tab is one place it is being
 * watched, and there may be none (a headless agent) or several (a split chat).
 * Where an event has a genuinely visual consequence — an unread dot — the
 * reducer resolves the session's tabs through the registry and fans out.
 */
export class SessionEventReducer {
  // Separate $state bag so per-chunk text updates don't re-run reactions on
  // other conversations.
  streaming = $state<{ text: Record<string, string> }>({ text: {} })
  // A session nobody is looking at does not render its stream. Keep its new
  // chunks append-only so concurrent background sessions avoid copying an
  // ever-growing string on every transport flush; materialize once when the
  // session becomes visible or commits.
  private hiddenTextChunks = new Map<string, string[]>()
  // An assembled assistant_message closes one logical prose block. Providers may
  // immediately stream another block without a tool call between them, so keep
  // that boundary until the next chunk and render it as a Markdown paragraph.
  private assistantMessageBoundaries = new Set<string>()
  // Extended thinking is never a message: only its duration survives, carried
  // onto the next tool call so the activity block can say "Thought for 6s".
  // Transport state, not domain state, so it lives here rather than on Session.
  private thinkingSpans = new WeakMap<Session, { startedAt?: number; pendingMs: number }>()
  /** Last authoritative settlement applied per mounted session. Transport
   *  retries must not replay unread state, sounds, or final refresh work. */
  private settledTurnIds = new WeakMap<Session, string>()
  /** One card per agent conversation per turn; exchanges keyed for late settles. */
  private agentConversations = new AgentConversationTracker()

  constructor(private deps: SessionEventReducerDeps) {}

  private thinkingSpan(session: Session): { startedAt?: number; pendingMs: number } {
    let span = this.thinkingSpans.get(session)
    if (!span) {
      span = { pendingMs: 0 }
      this.thinkingSpans.set(session, span)
    }
    return span
  }

  /** A user turn opened outside the event stream (the sender's own optimistic
   *  bubble — main excludes the sender from the user_message broadcast) must
   *  still cut the one-card-per-agent-per-turn boundary. */
  closeAgentConversationTurn(session: Session): void {
    this.agentConversations.closeTurn(session)
  }

  rebuildAgentConversations(session: Session): void {
    this.agentConversations.rebuild(session)
  }

  /** Hand the accumulated thinking time to the tool call it preceded. */
  private takeThinkingMs(session: Session): number | undefined {
    const span = this.thinkingSpan(session)
    const ms = span.pendingMs
    span.pendingMs = 0
    return ms > 0 ? ms : undefined
  }

  /** Mark every tab watching a session as unread, unless it is on screen. */
  private markUnread(sessionId: string): void {
    const isVisible = this.deps.isSessionVisible(sessionId)
    for (const tabId of this.deps.registry.tabIdsBySession.get(sessionId) ?? []) {
      const tab = this.deps.registry.tabs[tabId]
      if (tab) tab.hasUnread = !isVisible
    }
  }

  apply(sessionId: string, event: WireNormalizedEvent): void {
    const session = this.deps.registry.sessions[sessionId]
    if (!session) return

    if (session.status === 'interrupted' && !['task_complete', 'turn_settled', 'checkpoint', 'session_init', 'user_message', 'status_change', 'git_context', 'git_status', 'goal_updated', 'goal_cleared'].includes(event.type)) {
      return
    }

    // A tool's result (the sub-agent's final answer, or any tool's output) lands
    // on its tool message — never as a stray user/system bubble. This both drives
    // the sub-agent card's done/error state and kills the SDK's "tool results leak
    // as user messages" path.
    if (event.type === 'tool_result') {
      this.applyToolResult(session, event)
      return
    }
    if (event.type === 'subagent_report') {
      this.applySubagentReport(session, event)
      return
    }

    // Sub-agent (Agent/Task) events are tagged with the originating tool call.
    // Divert them into that parent tool's nested transcript instead of the main
    // thread, so they render inside the sub-agent card.
    const parentToolUseId = 'parentToolUseId' in event ? event.parentToolUseId : undefined

    if (event.type === 'thinking') {
      // A sub-agent card carries no duration rail, so its thinking is dropped
      // rather than folded into the parent's summary.
      if (parentToolUseId) return
      const span = this.thinkingSpan(session)
      if (event.state === 'start') {
        session.currentActivity = 'Thinking...'
        span.startedAt = Date.now()
      } else if (span.startedAt !== undefined) {
        span.pendingMs += Date.now() - span.startedAt
        span.startedAt = undefined
      }
      return
    }

    if (parentToolUseId) {
      this.applyChildEvent(session, parentToolUseId, event)
      return
    }

    if (event.type === 'text_chunk') {
      this.appendTextChunk(sessionId, session, event.text)
      return
    }

    if (session.rateLimitStrategy !== this.deps.settings.rateLimitBehavior) {
      session.rateLimitStrategy = this.deps.settings.rateLimitBehavior
    }

    this.commitPendingStream(sessionId)

    switch (event.type) {
      case 'session_init':
        session.run.provider = session.run.provider ?? this.deps.settings.activeAgent
        session.agentSessionId = event.sessionId
        const taskSessionId = taskBindingSessionId(session) ?? event.sessionId
        session.currentActivity = session.currentTurnStart === 'fresh'
          ? 'Connecting...'
          : 'Resuming...'
        session.sessionModel = event.model
        session.run.sessionSkills = event.skills
        if (event.handoffFrom) session.handoffFrom = event.handoffFrom
        if (session.forked) {
          session.forked = false
          session.forkExcludeLatestTurn = false
        }
        if (session.boundWorkId) {
          this.deps.worksStore.linkSession(session.run.workingDirectory, session.boundWorkId, event.sessionId)
        }
        // The task host owns the durable link, and only now is there a session
        // id to write into it — the execution host issues that, and on a
        // dispatch it is a different machine entirely. Keep the provisional
        // binding until the link is in the renderer store, so the sidebar never
        // projects this session as loose between the two states.
        const taskServerId = session.run.taskServerId
        const pendingTaskId = existingTaskId(session.task)
        if (pendingTaskId) {
          this.deps.tasksStore.trackSessionStart(pendingTaskId, taskSessionId)
          // On a dispatch this client is the only party that can name the
          // execution host, so it says so once and the task's host records the
          // session. The group path travels with it because the agent's own
          // checkout is a path on the borrowed machine.
          const isDispatch = session.run.serverId !== taskServerId
          void this.deps.tasksStore.linkSession(
            taskServerId,
            pendingTaskId,
              taskSessionId,
            isDispatch
              ? {
                  serverId: session.run.serverId,
                  provider: session.run.provider ?? undefined,
                  projectRoot: session.run.projectGroupPath,
                }
              : null,
            session.run.gitContext?.branch ?? null,
          )
        }
        void this.deps.tasksStore.refreshSessionBinding(taskSessionId, taskServerId)
          .then((task) => {
            if (!task) return
            if (existingTaskId(session.task) === pendingTaskId) session.task = { kind: 'new' }
            // The fork's subtask now exists and owns the nesting the provisional
            // parent stood in for.
            session.task = { kind: 'new' }
          })
          .catch(() => null)
        this.deps.onSessionInitialized?.(sessionId)
        break

      case 'tool_call': {
        session.currentActivity = ''
        session.messages.push({
          id: nextMsgId(),
          role: 'tool',
          content: '',
          toolName: event.toolName,
          toolId: event.toolId,
          toolIndex: event.index,
          toolInput: event.toolInput ?? '',
          toolStatus: 'running',
          subMessages: event.isSubagent ? [] : undefined,
          subagentType: event.subagentType,
          thinkingMs: this.takeThinkingMs(session),
          timestamp: Date.now(),
        })
        this.deps.workStreamTracker.beginToolArtifacts(
          session,
          event.toolName,
          session.run.provider ?? this.deps.settings.activeAgent,
        )
        break
      }

      case 'tool_call_update': {
        for (let i = session.messages.length - 1; i >= 0; i--) {
          const m = session.messages[i]
          if (
            m.role === 'tool' &&
            m.toolStatus === 'running' &&
            (!event.toolId || m.toolId === event.toolId) &&
            (event.index === undefined || m.toolIndex === event.index)
          ) {
            if (event.toolInput !== undefined) m.toolInput = event.toolInput
            break
          }
        }
        break
      }

      case 'tool_call_complete': {
        let completedFileMsg: Message | null = null
        for (let i = session.messages.length - 1; i >= 0; i--) {
          const m = session.messages[i]
          if (
            m.role === 'tool' &&
            m.toolStatus === 'running' &&
            (!event.toolId || m.toolId === event.toolId) &&
            (event.index === undefined || m.toolIndex === event.index)
          ) {
            // A main-thread tool's input arrives whole here (it streamed as deltas
            // the normalizer accumulated); set it before addChangedFilesFromMessage
            // parses it below.
            if (event.toolInput !== undefined) m.toolInput = event.toolInput
            // This marks the end of the *call*, which for a sub-agent is only the
            // moment its prompt finished streaming — the agent itself runs for
            // minutes yet. Its card settles on the agent's own result instead.
            if (!m.subMessages) {
              m.toolStatus = 'completed'
              m.toolCompletedAt = Date.now()
            }
            if (m.toolName === 'Write' || m.toolName === 'Edit' || m.toolName === 'exec_command') {
              completedFileMsg = m
            }
            break
          }
        }
        if (completedFileMsg) {
          // Incremental union from just this message — the full rescan runs at
          // task_complete to reconcile. Avoids re-parsing every historical body.
          this.deps.addChangedFilesFromMessage(sessionId, completedFileMsg)
          this.deps.onTurnSettled(sessionId, session.run.workingDirectory)
        }
        session.currentActivity = 'Thinking...'
        break
      }

      case 'assistant_message': {
        const lastUserIdx = findLastUserIndex(session.messages)
        let hasStreamedText = false
        if (lastUserIdx >= 0) {
          for (let i = lastUserIdx + 1; i < session.messages.length; i++) {
            const m = session.messages[i]
            if (m.role === 'assistant' && !m.toolName) { hasStreamedText = true; break }
          }
        }

        if (!hasStreamedText && event.text) {
          session.messages.push({
            id: nextMsgId(),
            role: 'assistant' as const,
            content: event.text,
            timestamp: Date.now(),
          })
        }
        this.assistantMessageBoundaries.add(sessionId)
        break
      }

      // Window occupancy and cumulative spend arrive together or apart
      // depending on provider, so neither assignment may clobber the other.
      case 'usage':
        if (event.context) session.contextUsage = event.context
        if (event.run) session.runUsage = event.run
        break

      case 'session_changed_files_updated': {
        const prev = session.sessionChangedFiles.join('\n')
        const next = event.paths.join('\n')
        if (prev !== next) {
          session.sessionChangedFiles.splice(0, session.sessionChangedFiles.length, ...event.paths)
          this.deps.onTurnSettled(sessionId, session.run.workingDirectory)
        }
        break
      }

      case 'progress': {
        const todos = event.todos.map((todo) => ({
          content: todo.content,
          status: normalizeTodoStatus(todo.status),
        }))
        session.progress = progressFromTodos(todos)
        break
      }

      // A sub-agent the SDK backgrounds reports its lifecycle out-of-band rather
      // than through its tool call, which already returned. These two events are
      // the only signal its card gets that the agent started and finished.
      case 'background_task_started': {
        if (event.toolUseId) {
          const msg = this.findToolMsg(session.messages, event.toolUseId)
          // Tag even a non-sub-agent task (backgrounded Bash): harmless, and it
          // keeps the settle lookup from depending on how the task was spawned.
          if (msg) msg.backgroundTaskId = event.taskId
        }
        break
      }

      case 'background_task_progress': {
        const msg = this.findBackgroundTaskMsg(session, event.taskId, event.toolUseId)
        if (!msg) break
        msg.backgroundTaskId = event.taskId
        const progress = msg.backgroundTaskProgress ??= {}
        if (event.description !== undefined) progress.description = event.description
        if (event.toolUses !== undefined) progress.toolUses = event.toolUses
        if (event.totalTokens !== undefined) progress.totalTokens = event.totalTokens
        if (event.durationMs !== undefined) progress.durationMs = event.durationMs
        if (event.lastToolName !== undefined) progress.lastToolName = event.lastToolName
        break
      }

      case 'background_task_settled': {
        const msg = this.findBackgroundTaskMsg(session, event.taskId, event.toolUseId)
        // Only a card still awaiting its agent settles here; a blocking sub-agent
        // already settled on its own tool_result, which is the richer signal.
        if (msg && msg.toolStatus === 'running') {
          msg.toolStatus = event.status === 'completed' ? 'completed' : 'error'
          msg.toolCompletedAt = Date.now()
        }
        break
      }

      case 'task_complete':
        this.finishProviderResultState(session)
        session.lastResult = {
          totalCostUsd: event.costUsd,
          durationMs: event.durationMs,
          numTurns: event.numTurns,
          sessionId: event.sessionId,
        }
        if (Object.keys(event.usage).length > 0) session.runUsage = event.usage
        if (event.result) {
          const lastUserIdx2 = findLastUserIndex(session.messages)
          let hasAnyText = false
          if (lastUserIdx2 >= 0) {
            for (let i = lastUserIdx2 + 1; i < session.messages.length; i++) {
              const m = session.messages[i]
              if (m.role === 'assistant' && !m.toolName) { hasAnyText = true; break }
            }
          }
          if (!hasAnyText) {
            session.messages.push({
              id: nextMsgId(),
              role: 'assistant' as const,
              content: event.result,
              timestamp: Date.now(),
            })
          }
        }
        if (session.status !== 'interrupted') {
          if (event.permissionDenials && event.permissionDenials.length > 0) {
            session.permissionDenied = { tools: event.permissionDenials }
          } else {
            session.permissionDenied = null
          }
        }
        break

      case 'turn_settled':
        if (this.settledTurnIds.get(session) === event.turnId) break
        this.settledTurnIds.set(session, event.turnId)
        session.currentTurnStartedAt = null
        this.deps.onTurnSettled(sessionId, session.run.workingDirectory)
        this.deps.refreshTurnSnapshots(sessionId)
        this.deps.workStreamTracker.sweep(session)
        if (event.outcome === 'completed' || event.outcome === 'failed') {
          this.markUnread(sessionId)
        }
        if (event.outcome === 'completed') {
          this.deps.playNotificationIfHidden()
        }
        break

      case 'error':
        if (session.status === 'interrupted') break
        this.markUnread(sessionId)
        this.resetSessionRunState(session)
        this.deps.workStreamTracker.sweep(session)
        session.terminalFailure = {
          content: `Error: ${event.message}`,
          timestamp: Date.now(),
        }
        session.messages.push({
          id: nextMsgId(),
          role: 'system',
          ...session.terminalFailure,
        })
        break

      case 'session_dead':
        this.markUnread(sessionId)
        this.resetSessionRunState(session)
        this.deps.workStreamTracker.sweep(session)
        session.terminalFailure = {
          content: `Session ended unexpectedly (exit ${event.exitCode})`,
          timestamp: Date.now(),
        }
        session.messages.push({
          id: nextMsgId(),
          role: 'system',
          ...session.terminalFailure,
        })
        break

      case 'permission_request':
        session.permissionQueue.push(toPermissionRequest(event))
        this.deps.playNotificationIfHidden()
        break

      case 'question_request':
        session.questionQueue.push(toQuestionRequest(event))
        this.deps.playNotificationIfHidden()
        break

      case 'pending_input_sync':
        this.deps.handlePendingInputSync(session, event.pendingInputEvents)
        break

      case 'permission_resolved': {
        const resolvedId = event.questionId
        const permIdx = session.permissionQueue.findIndex((p) => p.questionId === resolvedId)
        if (permIdx !== -1) session.permissionQueue.splice(permIdx, 1)
        const qIdx = session.questionQueue.findIndex((q) => q.questionId === resolvedId)
        if (qIdx !== -1) session.questionQueue.splice(qIdx, 1)
        break
      }

      case 'rate_limit':
        if (event.status === 'allowed_warning') {
          session.messages.push({
            id: nextMsgId(),
            role: 'system',
            content: event.message ?? `Rate limit warning (${event.rateLimitType}).`,
            timestamp: Date.now(),
            rateLimitNotice: true,
          })
          break
        }

        if (event.status !== 'allowed') {
          let content = event.message ?? `Rate limited (${event.rateLimitType}).`
          if (event.isUsingOverage || session.rateLimitStrategy === 'continue') {
            content += ' Using overage.'
          } else if (session.rateLimitStrategy === 'ask' || session.rateLimitStrategy === 'queue') {
            if (!event.info) break
            session.rateLimitInfo = event.info
            session.permissionQueue = []
            session.questionQueue = []
          } else if (session.rateLimitStrategy === 'stop') {
            session.outboundPrompts.splice(0, session.outboundPrompts.length)
          }

          session.messages.push({
            id: nextMsgId(),
            role: 'system',
            content,
            timestamp: Date.now(),
            rateLimitNotice: true,
          })
        }
        break

      case 'plan': {
        if (session.status === 'interrupted') break
        if (!event.planContent?.trim()) break

        removeAssistantPlanDuplicate(session.messages, event.planContent)

        const toolUseId = event.planToolUseId || uuid()
        const cwd = session.run.workingDirectory
        const projectPath = encodePathAsFolder(cwd)
        const planId = this.deps.planStore.upsertFromStream({
          serverId: session.run.serverId,
          sessionId: session.agentSessionId!,
          planToolUseId: toolUseId,
          projectPath,
          cwd,
          content: event.planContent,
          filePath: event.planFilePath,
          questionId: event.questionId || undefined,
          options: event.options.length > 0 ? event.options : undefined,
          timestamp: Date.now(),
        })
        const existingMessage = session.messages.find((m) => m.role === 'plan' && m.planId === planId)
        if (!existingMessage) {
          session.messages.push({
            id: nextMsgId(),
            role: 'plan' as const,
            content: '',
            planToolUseId: toolUseId,
            planId,
            timestamp: Date.now(),
          })
        }
        this.deps.playNotificationIfHidden()
        break
      }

      case 'status_card':
        session.statusCard = mergeRemoteDispatchProgress(session.statusCard, event.card)
        break

      case 'git_context':
        session.run.gitContext = event.gitContext
        if (event.gitContext.worktreePath) session.run.worktree = null
        // A dispatched host can create its worktree after session_init. Carry
        // that authoritative branch back to the task host when it arrives, or
        // the durable attempt stays branchless and PR discovery cannot recover
        // it after a client refresh.
        if (session.agentSessionId && event.gitContext.branch) {
          const taskSessionId = taskBindingSessionId(session)
          const task = this.deps.tasksStore.taskForSession(taskSessionId)
          const taskServerId = session.run.taskServerId
          if (
            task
            && taskServerId
            && taskSessionId
            && this.deps.tasksStore.sessionBranchFor(task.id, taskSessionId) !== event.gitContext.branch
          ) {
            void this.deps.tasksStore.linkSession(
              taskServerId,
              task.id,
              taskSessionId,
              null,
              event.gitContext.branch,
            ).then(() => this.deps.tasksStore.refreshSessionBinding(taskSessionId, taskServerId))
              .catch(() => null)
          }
        }
        break

      case 'git_status':
        // Pushed live from the main-process git watcher — lands in the same
        // store the Environment panel and pill already read by cwd.
        this.deps.setGitStatus(event.cwd, event.state)
        break

      case 'checkpoint':
        session.latestCheckpointId = event.checkpointId
        break

      case 'user_message': {
        // An agent's report is turn input for the model, never a bubble —
        // the agent-conversation card already carries the reply via its `settled` update.
        if (event.via === 'session-report') break
        // The provider persists an interrupt as a user turn so its transcript
        // remains well-formed. The renderer has already inserted the divider
        // optimistically on Ctrl-C, so only retain a provider notice when it
        // is not confirming the divider already at the transcript tail.
        if (isAgentNotice(event.text)) {
          const lastMessage = session.messages[session.messages.length - 1]
          if (!lastMessage || !isAgentNotice(lastMessage.content)) {
            session.messages.push({
              id: event.clientPromptId ?? nextMsgId(),
              role: 'system',
              content: event.text,
              timestamp: Date.now(),
            })
          }
          break
        }
        const outbound = this.takeOutboundPrompt(session, event.clientPromptId)
        if (event.delivery === 'steer') {
          session.currentTurnStart = 'steer'
          session.currentActivity = 'Steering...'
        }
        // A real user turn starts a new attempt, including provider-originated
        // prompts such as in-thread automations that have no optimistic bubble.
        session.currentTurnStartedAt ??= Date.now()
        session.terminalFailure = null
        this.agentConversations.closeTurn(session)
        const message: Message = {
          id: event.clientPromptId ?? nextMsgId(),
          role: 'user',
          content: event.text,
          timestamp: Date.now(),
          clientPromptId: event.clientPromptId,
          delivery: event.delivery,
        }
        // A prompt the limit held states its wait once it lands, so the bubble
        // that was dashed a moment ago closes the loop instead of vanishing.
        if (outbound?.reason === 'rate_limit' && outbound.enqueuedAt) {
          message.queuedWaitMs = Date.now() - outbound.enqueuedAt
        }
        if (outbound?.attachments?.length) {
          message.attachments = outbound.attachments
        } else if (event.imageAttachments?.length) {
          message.attachments = event.imageAttachments.map((image) => ({
            name: '',
            dataUrl: image.dataUrl,
            mimeType: image.mimeType,
            type: 'image',
          }))
        }
        if (outbound?.planRefs?.length) message.planRefs = outbound.planRefs
        if (outbound?.workRefs?.length) message.workRefs = outbound.workRefs
        if (outbound?.sessionRefs?.length) message.sessionRefs = outbound.sessionRefs
        if (event.via) {
          message.via = event.via
          message.automationId = event.automationId
          message.automationName = event.automationName
        }
        session.messages.push(message)
        break
      }

      case 'prompt_queued': {
        // A queued session report is invisible plumbing — no outbound chip.
        if (event.via === 'session-report') break
        const existing = event.clientPromptId
          ? session.outboundPrompts.find((prompt) => prompt.clientPromptId === event.clientPromptId)
          : session.outboundPrompts.find((prompt) => prompt.queueId === event.queueId)
        if (existing) {
          existing.queueId = event.queueId
          existing.state = 'queued'
          existing.enqueuedAt = event.enqueuedAt
          existing.reason = event.reason ?? 'busy'
          existing.releaseAt = event.releaseAt
          existing.rateLimitType = event.rateLimitType
          existing.images = event.images
        } else {
          session.outboundPrompts.push({
            clientPromptId: event.clientPromptId ?? `queued:${event.queueId}`,
            queueId: event.queueId,
            text: event.text,
            state: 'queued',
            enqueuedAt: event.enqueuedAt,
            reason: event.reason ?? 'busy',
            releaseAt: event.releaseAt,
            rateLimitType: event.rateLimitType,
            images: event.images,
          })
        }
        break
      }

      case 'prompt_dequeued': {
        const idx = session.outboundPrompts.findIndex((prompt) => prompt.queueId === event.queueId)
        if (idx !== -1) session.outboundPrompts.splice(idx, 1)
        break
      }

      case 'prompt_queue_updated': {
        const prompt = session.outboundPrompts.find((outbound) => outbound.queueId === event.queueId)
        if (prompt) prompt.text = event.text
        break
      }

      case 'rate_limit_resolved':
        session.rateLimitInfo = null
        break

      case 'goal_updated': {
        const isNewGoal = this.deps.applyGoalUpdated
          ? this.deps.applyGoalUpdated(sessionId, event.goal)
          : !session.goal
        if (!this.deps.applyGoalUpdated) session.goal = event.goal
        if (isNewGoal) this.deps.onGoalDefined?.(sessionId)
        break
      }

      case 'goal_cleared':
        if (this.deps.applyGoalCleared) {
          this.deps.applyGoalCleared(sessionId, event.threadId)
        } else if (!session.agentSessionId || event.threadId === session.agentSessionId) {
          session.goal = null
        }
        break

      case 'plan_rejected': {
        const planMsg = session.messages.find(
          (m) => m.role === 'plan' && m.planToolUseId === event.planToolUseId,
        )
        if (planMsg?.planId) {
          const plan = this.deps.planStore.plans[planMsg.planId]
          if (plan && plan.status === 'pending') {
            this.deps.planStore.setStatus(planMsg.planId, 'rejected')
          }
        }
        break
      }

      case 'permission_mode_changed':
        session.run.permissionMode = event.permissionMode
        break

      case 'status_change':
        session.status = event.status
        if (event.status === 'connecting' || event.status === 'running') {
          // Remote/provider-originated turns may announce their status before
          // their user_message arrives. Start the visible clock at that first
          // evidence of work instead of leaving the sidebar margin blank.
          session.currentTurnStartedAt ??= Date.now()
        } else if (event.status === 'idle') {
          session.currentTurnStartedAt = null
        }
        // The status card tracks the pre-run setup phase (worktree creation,
        // session handshake), which only lives while 'connecting'. Once we
        // leave that state the card's job is done — clear it so the agent's
        // output takes over. Keep failed cards so the error stays visible.
        if (event.status !== 'connecting' && session.statusCard && session.statusCard.status !== 'error') {
          session.statusCard = null
        }
        if (event.status === 'interrupted') {
          session.outboundPrompts.splice(0, session.outboundPrompts.length)
          this.deps.closePlanModal()
        }
        if (event.status === 'idle') {
          session.isStreamingText = false
          session.isReconnecting = false
          session.permissionQueue = []
          session.questionQueue = []
          session.permissionDenied = null
        }
        break

      case 'work_created': {
        this.deps.workStreamTracker.finalizeWork(session, event)
        if (session.agentSessionId) this.deps.worksStore.linkSessionLocal(event.workId, session.agentSessionId)
        this.deps.playNotificationIfHidden()
        break
      }

      case 'work_updated': {
        void this.deps.worksStore.applyRemoteUpdate(event.workId, event.title, event.docType, event.content, event.updatedAt, session.run.serverId)
        break
      }

      case 'artifact_created': {
        this.deps.workStreamTracker.finalizeArtifact(session, event)
        this.deps.playNotificationIfHidden()
        break
      }

      case 'automation_saved': {
        session.messages.push({
          id: nextMsgId(),
          role: 'assistant',
          content: '',
          automationRef: {
            automationId: event.automationId,
            name: event.name,
            trigger: event.trigger,
            enabled: event.enabled,
          },
          timestamp: Date.now(),
        })
        // Keep the automations page/list in sync if it's open elsewhere.
        void this.deps.automationsStore.loadAll()
        this.deps.playNotificationIfHidden()
        break
      }

      case 'task_created': {
        session.messages.push({
          id: nextMsgId(),
          role: 'assistant',
          content: '',
          taskRef: {
            taskId: event.taskId,
            title: event.title,
            url: event.url,
          },
          timestamp: Date.now(),
        })
        this.deps.playNotificationIfHidden()
        break
      }

      case 'agent_conversation_update': {
        const { newCard, needsAttention } = this.agentConversations.apply(session, event.update)
        if (newCard || needsAttention) this.deps.playNotificationIfHidden()
        break
      }
    }

    this.deps.log(event.type, session)
  }

  /**
   * End the session's run and clear the live state that belongs to it.
   *
   * `notice` writes the stop into the transcript, which is what makes the turn
   * read as "you cut this short". Pass false when the run ended because the
   * thread moved on rather than because the reader stopped it — accepting a plan
   * hands the work to the implementation session and says so with its own
   * divider, so a stop notice there would report an event that never happened.
   */
  interruptSession(sessionId: string, opts: { notice?: boolean } = {}): void {
    const { notice = true } = opts
    const session = this.deps.registry.sessions[sessionId]
    if (!session) return
    this.commitPendingStream(sessionId)
    this.deps.workStreamTracker.sweep(session)
    session.status = 'interrupted'
    // Setup cards represent live work, not transcript history. Remove one
    // optimistically so Ctrl-C never leaves a stale setup step on screen while
    // the stop RPC cancels any pre-session work still in flight.
    session.statusCard = null
    this.resetSessionRunState(session)
    const lastMessage = session.messages[session.messages.length - 1]
    if (notice && (!lastMessage || !isAgentNotice(lastMessage.content))) {
      session.messages.push({
        id: nextMsgId(),
        role: 'system',
        content: AGENT_INTERRUPT_NOTICE,
        timestamp: Date.now(),
      })
    }
    session.outboundPrompts.splice(0, session.outboundPrompts.length)
    this.deps.closePlanModal()
    this.deps.log('interrupt', session)
  }

  handleError(sessionId: string, error: EnrichedError): void {
    const session = this.deps.registry.sessions[sessionId]
    if (!session) return
    if (session.status === 'interrupted') return

    this.commitPendingStream(sessionId)
    const lastMsg = session.messages[session.messages.length - 1]
    const alreadyHasError = lastMsg?.role === 'system' && lastMsg.content.startsWith('Error:')

    // A rate-limited run rejects the dispatch promise, landing here on a separate
    // IPC path from the rate_limit event that fills in rateLimitInfo. Gating on
    // rateLimitInfo races that event (status_change arrives first), so the error
    // would clobber status → 'failed' and hide the card. Gate on the strategy
    // instead — it's stable and set at session creation.
    const keepRateLimited =
      session.status === 'rate_limited' &&
      (session.rateLimitStrategy === 'ask' || session.rateLimitStrategy === 'queue')
    if (!keepRateLimited) session.status = 'failed'
    this.resetSessionRunState(session)
    if (keepRateLimited) {
      this.deps.log('rate_limit_error_suppressed', session)
      return
    }
    this.markUnread(sessionId)
    if (!alreadyHasError) {
      session.terminalFailure = {
        content: `Error: ${error.message}${error.stderrTail.length > 0 ? '\n\n' + error.stderrTail.slice(-5).join('\n') : ''}`,
        timestamp: Date.now(),
      }
      session.messages.push({
        id: nextMsgId(),
        role: 'system' as const,
        ...session.terminalFailure,
      })
    } else if (lastMsg) {
      session.terminalFailure = {
        content: lastMsg.content,
        timestamp: lastMsg.timestamp,
      }
    }
    this.deps.log('error', session)
  }

  /** Newest-first scan for a tool message by its tool_use id. */
  private findToolMsg(list: Message[], toolId: string): Message | undefined {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m.role === 'tool' && m.toolId === toolId) return m
    }
    return undefined
  }

  /**
   * Land a tool_result on its tool message. The parent Agent tool's result
   * is a separate subagent_report event. This path only records the bounded
   * status metadata for ordinary main-thread and nested tool calls.
   */
  private applyToolResult(session: Session, event: Extract<WireNormalizedEvent, { type: 'tool_result' }>): void {
    const parent = event.parentToolUseId ? this.findToolMsg(session.messages, event.parentToolUseId) : undefined
    const list = parent?.subMessages ?? session.messages
    const target = this.findToolMsg(list, event.toolUseId)
    if (!target) return
    target.errorHead = event.errorHead
    target.contentBytes = event.contentBytes
    target.toolStatus = event.status === 'error' ? 'error' : 'completed'
    target.toolCompletedAt = Date.now()
    if (!event.parentToolUseId) session.currentActivity = 'Thinking...'
  }

  private applySubagentReport(session: Session, event: Extract<WireNormalizedEvent, { type: 'subagent_report' }>): void {
    const target = this.findToolMsg(session.messages, event.toolUseId)
    if (!target) return
    target.report = event.text
    target.toolStatus = event.isError ? 'error' : 'completed'
    target.toolCompletedAt = Date.now()
    session.currentActivity = 'Thinking...'
  }

  /**
   * Settle the sub-agent card for a background task. Only task_started carries the
   * spawning `tool_use_id`, so the card is tagged with its task id then and found
   * by that here — task_updated reports the outcome with no tool_use_id at all.
   */
  private findBackgroundTaskMsg(session: Session, taskId: string, toolUseId?: string): Message | undefined {
    if (toolUseId) {
      const byTool = this.findToolMsg(session.messages, toolUseId)
      if (byTool) return byTool
    }
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i]
      if (m.role === 'tool' && m.backgroundTaskId === taskId) return m
    }
    return undefined
  }

  /**
   * Apply a sub-agent event to its parent tool's nested transcript, mirroring the
   * main-thread push/update/complete/text logic but scoped to `subMessages`.
   */
  private applyChildEvent(session: Session, parentToolUseId: string, event: WireNormalizedEvent): void {
    const parent = this.findToolMsg(session.messages, parentToolUseId)
    if (!parent) return
    if (!parent.subMessages) parent.subMessages = []
    const subs = parent.subMessages

    switch (event.type) {
      case 'text_chunk': {
        if (!event.text) break
        const lastSub = subs[subs.length - 1]
        if (lastSub?.role === 'assistant' && !lastSub.toolName && lastSub.isStreaming) {
          lastSub.content += event.text
        } else {
          subs.push({
            id: nextMsgId(),
            role: 'assistant',
            content: event.text,
            isStreaming: true,
            timestamp: Date.now(),
          })
        }
        break
      }

      case 'tool_call':
        // Sub-agent tool calls are synthesized from assembled assistant messages,
        // which can be re-delivered (resume/replay); skip if we already have it.
        if (event.toolId && subs.some((m) => m.role === 'tool' && m.toolId === event.toolId)) break
        subs.push({
          id: nextMsgId(),
          role: 'tool',
          content: '',
          toolName: event.toolName,
          toolId: event.toolId,
          toolIndex: event.index,
          toolInput: event.toolInput ?? '',
          toolStatus: 'running',
          timestamp: Date.now(),
        })
        break

      case 'tool_call_update':
        for (let i = subs.length - 1; i >= 0; i--) {
          const m = subs[i]
          if (
            m.role === 'tool' &&
            m.toolStatus === 'running' &&
            (!event.toolId || m.toolId === event.toolId) &&
            (event.index === undefined || m.toolIndex === event.index)
          ) {
            if (event.toolInput !== undefined) m.toolInput = event.toolInput
            break
          }
        }
        break

      // The sub-agent's own plan, kept on its card. Each write replaces the whole
      // list, spliced in place so the card re-reads without invalidating the
      // parent message's other derivations.
      case 'progress': {
        const todos = event.todos.map((todo) => ({
          content: todo.content,
          status: normalizeTodoStatus(todo.status),
        }))
        if (parent.subTodos) parent.subTodos.splice(0, parent.subTodos.length, ...todos)
        else parent.subTodos = todos
        break
      }

      case 'tool_call_complete':
        for (let i = subs.length - 1; i >= 0; i--) {
          const m = subs[i]
          if (
            m.role === 'tool' &&
            m.toolStatus === 'running' &&
            (!event.toolId || m.toolId === event.toolId) &&
            (event.index === undefined || m.toolIndex === event.index)
          ) {
            if (event.toolInput !== undefined) m.toolInput = event.toolInput
            m.toolStatus = 'completed'
            break
          }
        }
        break

      case 'assistant_message': {
        // Live sub-agent text streams first, then the assembled assistant_message
        // replaces that block authoritatively. Replay only delivers assembled
        // messages, so dedupe exact re-deliveries while preserving distinct blocks.
        if (!event.text) break
        const text = event.text
        const lastSub = subs[subs.length - 1]
        if (lastSub?.role === 'assistant' && !lastSub.toolName && lastSub.isStreaming) {
          lastSub.content = text
          delete lastSub.isStreaming
        } else if (!(lastSub?.role === 'assistant' && !lastSub.toolName && lastSub.content === text)) {
          subs.push({ id: nextMsgId(), role: 'assistant', content: text, timestamp: Date.now() })
        }
        if (event.isFinal) {
          parent.toolStatus = 'completed'
          parent.toolCompletedAt = Date.now()
        }
        break
      }
    }
  }

  appendTextChunk(sessionId: string, session: Session, text: string): void {
    const startsNewAssistantMessage = this.assistantMessageBoundaries.delete(sessionId)
    const lastMessage = session.messages[session.messages.length - 1]
    const separator = startsNewAssistantMessage &&
      lastMessage?.role === 'assistant' &&
      !lastMessage.toolName &&
      !lastMessage.artifact &&
      !lastMessage.workRef &&
      !lastMessage.automationRef &&
      !lastMessage.agentConversationRef
      ? '\n\n'
      : ''
    const nextText = separator + text
    if (this.deps.isSessionVisible(sessionId)) {
      this.streaming.text[sessionId] = this.pendingText(sessionId) + nextText
      this.hiddenTextChunks.delete(sessionId)
    } else {
      const chunks = this.hiddenTextChunks.get(sessionId)
      if (chunks) chunks.push(nextText)
      else this.hiddenTextChunks.set(sessionId, [nextText])
    }
    if (!session.isStreamingText) session.isStreamingText = true
  }

  streamingTextFor(sessionId: string, isVisible: boolean): string {
    const current = this.streaming.text[sessionId] ?? ''
    if (!isVisible) return current
    const chunks = this.hiddenTextChunks.get(sessionId)
    return chunks?.length ? current + chunks.join('') : current
  }

  clearStreamingText(sessionId: string): void {
    delete this.streaming.text[sessionId]
    this.hiddenTextChunks.delete(sessionId)
  }

  private pendingText(sessionId: string): string {
    const current = this.streaming.text[sessionId] ?? ''
    const chunks = this.hiddenTextChunks.get(sessionId)
    return chunks?.length ? current + chunks.join('') : current
  }

  commitPendingStream(sessionId: string): void {
    const pendingText = this.pendingText(sessionId)
    this.clearStreamingText(sessionId)
    const session = this.deps.registry.sessions[sessionId]
    if (session) session.isStreamingText = false
    if (!pendingText) return
    if (!session) return
    const lastMsg = session.messages[session.messages.length - 1]
    if (
      lastMsg?.role === 'assistant' &&
      !lastMsg.toolName &&
      !lastMsg.artifact &&
      !lastMsg.workRef &&
      !lastMsg.automationRef &&
      !lastMsg.agentConversationRef
    ) {
      lastMsg.content += pendingText
    } else {
      session.messages.push({
        id: nextMsgId(),
        role: 'assistant' as const,
        content: pendingText,
        timestamp: Date.now(),
      })
    }
  }

  /** Close provider-result streaming without claiming that the whole Solus turn
   *  has settled. Background work can continue after `task_complete`, so the
   *  elapsed turn clock stays live until `turn_settled`. */
  private finishProviderResultState(session: Session): void {
    session.currentActivity = ''
    session.currentTurnStart = null
    session.isStreamingText = false
    session.isReconnecting = false
    // Empty in place, and only when non-empty: swapping the array reference
    // invalidates every $derived reading the queue; a no-op turn end writes nothing.
    if (session.permissionQueue.length) session.permissionQueue.splice(0, session.permissionQueue.length)
    if (session.questionQueue.length) session.questionQueue.splice(0, session.questionQueue.length)
    session.permissionDenied = null
    // Thinking that never reached a tool call has nowhere to be printed; drop it
    // at the turn boundary so it can't attach to the next turn's first tool.
    const span = this.thinkingSpans.get(session)
    if (span) {
      span.startedAt = undefined
      span.pendingMs = 0
    }
  }

  resetSessionRunState(session: Session): void {
    this.finishProviderResultState(session)
    session.currentTurnStartedAt = null
  }

  private takeOutboundPrompt(session: Session, clientPromptId?: string) {
    if (!clientPromptId) return undefined
    const index = session.outboundPrompts.findIndex((prompt) => prompt.clientPromptId === clientPromptId)
    if (index === -1) return undefined
    const [prompt] = session.outboundPrompts.splice(index, 1)
    return prompt
  }
}
