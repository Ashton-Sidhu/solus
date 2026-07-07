import type { AgentId, EnrichedError, GitProjectStatus, Message, NormalizedEvent, Session, Tab } from '../../shared/types'
import { encodePathAsFolder } from '../../shared/types'
import { uuid } from '../../shared/uuid'
import type { SettingsContext } from './settings.context.svelte'
import type { PlanStore } from './plan.store.svelte'
import type { WorksStore } from './works.store.svelte'
import type { TasksStore } from './tasks.store.svelte'
import type { AutomationsStore } from './automations.store.svelte'
import type { TabRegistry } from './tab-registry.svelte'
import type { WorkStreamTracker } from './work-stream-tracker.svelte'
import { findLastUserIndex, normalizeTodoStatus, nextMsgId, progressFromTodos, removeAssistantPlanDuplicate, toPermissionRequest, toQuestionRequest } from './session.utils'

const FINISHED_STATUSES = new Set(['completed', 'failed', 'dead', 'interrupted'])

export interface SessionEventReducerDeps {
  registry: TabRegistry
  settings: SettingsContext
  planStore: PlanStore
  worksStore: WorksStore
  tasksStore: TasksStore
  automationsStore: AutomationsStore
  workStreamTracker: WorkStreamTracker
  isTabVisible(tabId: string): boolean
  recomputeChangedFiles(tabId: string): void
  addChangedFilesFromMessage(tabId: string, message: Message): void
  refreshTurnSnapshots(tabId: string): void
  setGitStatus(cwd: string, status: GitProjectStatus | null): void
  playNotificationIfHidden(): void
  closePlanModal(): void
  onTurnSettled(tabId: string, cwd: string | null): void
  handlePendingInputSync(session: Session, events: Extract<NormalizedEvent, { type: 'pending_input_sync' }>['pendingInputEvents']): void
  log(tab: Tab, eventType: string, session: Session): void
}

export class SessionEventReducer {
  // Separate $state bag so per-chunk text updates don't re-run reactions on other tabs.
  streaming = $state<{ text: Record<string, string> }>({ text: {} })

  constructor(private deps: SessionEventReducerDeps) {}

  apply(tabId: string, event: NormalizedEvent): void {
    const tab = this.deps.registry.tabs[tabId]
    if (!tab) return
    const session = this.deps.registry.sessions[tab.sessionId]
    if (!session) return

    if (session.status === 'interrupted' && !['task_complete', 'checkpoint', 'session_init', 'user_message', 'status_change'].includes(event.type)) {
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

    // Sub-agent (Agent/Task) events are tagged with the originating tool call.
    // Divert them into that parent tool's nested transcript instead of the main
    // thread, so they render inside the sub-agent card.
    const parentToolUseId = 'parentToolUseId' in event ? event.parentToolUseId : undefined
    if (parentToolUseId) {
      this.applyChildEvent(session, parentToolUseId, event)
      return
    }

    if (event.type === 'text_chunk') {
      this.appendTextChunk(tabId, session, event.text)
      return
    }

    if (session.rateLimitStrategy !== this.deps.settings.rateLimitBehavior) {
      session.rateLimitStrategy = this.deps.settings.rateLimitBehavior
    }

    this.commitPendingStream(tabId)

    switch (event.type) {
      case 'session_init':
        session.provider = session.provider ?? this.deps.settings.activeAgent
        session.agentSessionId = event.sessionId
        session.sessionModel = event.model
        session.sessionSkills = event.skills
        if (session.forked) session.forked = false
        if (session.boundWorkId) {
          this.deps.worksStore.linkSessionLocal(session.boundWorkId, event.sessionId)
          void window.solus.linkWorkSession(session.boundWorkId, event.sessionId, session.workingDirectory)
        }
        if (session.boundTaskId) {
          // Persist the task↔session link so the card can surface live work and a
          // jump-back even after the session's renderer-only boundTaskId resets.
          this.deps.tasksStore.linkSession(session.workingDirectory, session.boundTaskId, event.sessionId)
        }
        break

      case 'tool_call': {
        session.messages.push({
          id: nextMsgId(),
          role: 'tool',
          content: event.content ?? '',
          toolName: event.toolName,
          toolId: event.toolId,
          toolIndex: event.index,
          toolInput: event.toolInput ?? '',
          toolStatus: 'running',
          subMessages: event.isSubagent ? [] : undefined,
          subagentType: event.subagentType,
          timestamp: Date.now(),
        })
        this.deps.workStreamTracker.beginToolArtifacts(
          tabId,
          session,
          event.toolName,
          (session.provider ?? this.deps.settings.activeAgent) as AgentId,
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
            if (event.content !== undefined) {
              m.content = event.content
            }
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
            m.toolStatus = 'completed'
            if (m.toolName === 'Write' || m.toolName === 'Edit' || m.toolName === 'exec_command') {
              completedFileMsg = m
            }
            break
          }
        }
        if (completedFileMsg) {
          // Incremental union from just this message — the full rescan runs at
          // task_complete to reconcile. Avoids re-parsing every historical body.
          this.deps.addChangedFilesFromMessage(tabId, completedFileMsg)
          this.deps.onTurnSettled(tabId, session.workingDirectory)
        }
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
        break
      }

      case 'usage':
        if (event.sessionUsage) session.sessionUsage = event.sessionUsage
        break

      case 'changed_files_updated': {
        const prev = session.changedFiles.join('\n')
        const next = event.paths.join('\n')
        if (prev !== next) {
          session.changedFiles.splice(0, session.changedFiles.length, ...event.paths)
          this.deps.onTurnSettled(tabId, session.workingDirectory)
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

      case 'task_complete':
        this.resetSessionRunState(session)
        session.lastResult = {
          totalCostUsd: event.costUsd,
          durationMs: event.durationMs,
          numTurns: event.numTurns,
          sessionId: event.sessionId,
        }
        if (Object.keys(event.usage).length > 0) session.sessionUsage = event.usage
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
        tab.hasUnread = !this.deps.isTabVisible(tabId)
        if (session.status !== 'interrupted') {
          if (event.permissionDenials && event.permissionDenials.length > 0) {
            session.permissionDenied = { tools: event.permissionDenials }
          } else {
            session.permissionDenied = null
          }
        }
        if (session.provider !== 'codex') this.deps.recomputeChangedFiles(tabId)
        this.deps.onTurnSettled(tabId, session.workingDirectory)
        this.deps.refreshTurnSnapshots(tabId)
        this.deps.workStreamTracker.sweep(tabId, session)
        this.deps.playNotificationIfHidden()
        break

      case 'error':
        if (session.status === 'interrupted') break
        this.resetSessionRunState(session)
        this.deps.workStreamTracker.sweep(tabId, session)
        session.messages.push({
          id: nextMsgId(),
          role: 'system',
          content: `Error: ${event.message}`,
          timestamp: Date.now(),
        })
        break

      case 'session_dead':
        this.resetSessionRunState(session)
        this.deps.workStreamTracker.sweep(tabId, session)
        session.messages.push({
          id: nextMsgId(),
          role: 'system',
          content: `Session ended unexpectedly (exit ${event.exitCode})`,
          timestamp: Date.now(),
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
            session.serverQueuedPrompts.splice(0, session.serverQueuedPrompts.length)
          }

          session.messages.push({
            id: nextMsgId(),
            role: 'system',
            content,
            timestamp: Date.now(),
          })
        }
        break

      case 'plan': {
        if (session.status === 'interrupted') break
        if (!event.planContent?.trim()) break

        removeAssistantPlanDuplicate(session.messages, event.planContent)

        const toolUseId = event.planToolUseId || uuid()
        const cwd = session.workingDirectory
        const projectPath = encodePathAsFolder(cwd)
        const planId = this.deps.planStore.upsertFromStream({
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
        session.statusCard = event.card
        break

      case 'git_context':
        session.gitContext = event.gitContext
        if (event.gitContext.worktreePath) session.worktreeBaseBranch = null
        break

      case 'git_status':
        // Pushed live from the main-process git watcher — lands in the same
        // store the Environment panel and pill already read by cwd.
        this.deps.setGitStatus(event.cwd, event.status)
        break

      case 'checkpoint':
        session.latestCheckpointId = event.checkpointId
        break

      case 'user_message':
        session.messages.push({
          id: nextMsgId(),
          role: 'user' as const,
          content: event.text,
          timestamp: Date.now(),
          ...(event.imageAttachments?.length
            ? { attachments: event.imageAttachments.map((img) => ({ name: '', dataUrl: img.dataUrl, mimeType: img.mimeType, type: 'image' as const })) }
            : {}),
          ...(event.via ? { via: event.via, automationId: event.automationId, automationName: event.automationName } : {}),
        })
        break

      case 'prompt_queued':
        if (!session.serverQueuedPrompts.some((queued) => queued.queueId === event.queueId)) {
          session.serverQueuedPrompts.push({
            queueId: event.queueId,
            text: event.text,
            enqueuedAt: event.enqueuedAt,
            reason: event.reason ?? 'busy',
            releaseAt: event.releaseAt,
            rateLimitType: event.rateLimitType,
            images: event.images,
          })
        }
        break

      case 'prompt_dequeued': {
        const idx = session.serverQueuedPrompts.findIndex((queued) => queued.queueId === event.queueId)
        if (idx !== -1) session.serverQueuedPrompts.splice(idx, 1)
        break
      }

      case 'rate_limit_resolved':
        session.rateLimitInfo = null
        break

      case 'goal_updated':
      case 'goal_cleared':
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
        session.permissionMode = event.permissionMode
        break

      case 'status_change':
        session.status = event.status
        // The status card tracks the pre-run setup phase (worktree creation,
        // session handshake), which only lives while 'connecting'. Once we
        // leave that state the card's job is done — clear it so the agent's
        // output takes over. Keep failed cards so the error stays visible.
        if (event.status !== 'connecting' && session.statusCard && session.statusCard.status !== 'error') {
          session.statusCard = null
        }
        if (event.status === 'interrupted') {
          session.serverQueuedPrompts.splice(0, session.serverQueuedPrompts.length)
          this.deps.closePlanModal()
        }
        if (FINISHED_STATUSES.has(event.status) || event.status === 'idle') {
          session.isStreamingText = false
          session.isReconnecting = false
          session.permissionQueue = []
          session.questionQueue = []
          session.permissionDenied = null
        }
        break

      case 'work_created': {
        this.deps.workStreamTracker.finalizeWork(tabId, session, event)
        if (session.agentSessionId) this.deps.worksStore.linkSessionLocal(event.workId, session.agentSessionId)
        this.deps.playNotificationIfHidden()
        break
      }

      case 'work_updated': {
        void this.deps.worksStore.applyRemoteUpdate(event.workId, event.title, event.docType, event.content, event.updatedAt)
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

      case 'session_created': {
        session.messages.push({
          id: nextMsgId(),
          role: 'assistant',
          content: '',
          sessionRef: {
            agentSessionId: event.agentSessionId,
            title: event.title,
            provider: event.provider,
            cwd: event.cwd,
            verb: 'Started',
          },
          timestamp: Date.now(),
        })
        this.deps.playNotificationIfHidden()
        break
      }

      case 'session_prompted': {
        session.messages.push({
          id: nextMsgId(),
          role: 'assistant',
          content: '',
          sessionRef: {
            agentSessionId: event.agentSessionId,
            title: event.promptPreview,
            provider: event.provider,
            cwd: event.cwd,
            verb: 'Prompted',
          },
          timestamp: Date.now(),
        })
        this.deps.playNotificationIfHidden()
        break
      }

      case 'session_stopped': {
        session.messages.push({
          id: nextMsgId(),
          role: 'assistant',
          content: '',
          sessionRef: {
            agentSessionId: event.agentSessionId,
            title: event.agentSessionId,
            provider: event.provider,
            cwd: event.cwd,
            verb: 'Stopped',
          },
          timestamp: Date.now(),
        })
        this.deps.playNotificationIfHidden()
        break
      }
    }

    this.deps.log(tab, event.type, session)
  }

  interruptTab(tabId: string): void {
    const session = this.deps.registry.sessionFor(tabId)
    const tab = this.deps.registry.tabs[tabId]
    if (!session || !tab) return
    this.commitPendingStream(tabId)
    this.deps.workStreamTracker.sweep(tabId, session)
    session.status = 'interrupted'
    this.resetSessionRunState(session)
    session.serverQueuedPrompts.splice(0, session.serverQueuedPrompts.length)
    this.deps.closePlanModal()
    this.deps.registry.forEachSiblingTab(tabId, (siblingId) => {
      this.commitPendingStream(siblingId)
    })

    this.deps.log(tab, 'interrupt', session)
  }

  handleError(tabId: string, error: EnrichedError): void {
    const session = this.deps.registry.sessionFor(tabId)
    const tab = this.deps.registry.tabs[tabId]
    if (!session || !tab) return
    if (session.status === 'interrupted') return

    this.commitPendingStream(tabId)
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
      this.deps.log(tab, 'rate_limit_error_suppressed', session)
      return
    }
    if (!alreadyHasError) {
      session.messages.push({
        id: nextMsgId(),
        role: 'system' as const,
        content: `Error: ${error.message}${error.stderrTail.length > 0 ? '\n\n' + error.stderrTail.slice(-5).join('\n') : ''}`,
        timestamp: Date.now(),
      })
    }
    this.deps.log(tab, 'error', session)
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
   * (parentToolUseId == null) lands in the main thread and flips the sub-agent
   * card to done/error; a sub-agent's inner tool result lands in that parent's
   * subMessages. Non-sub-agent results just set fields nothing else reads.
   */
  private applyToolResult(session: Session, event: Extract<NormalizedEvent, { type: 'tool_result' }>): void {
    const parent = event.parentToolUseId ? this.findToolMsg(session.messages, event.parentToolUseId) : undefined
    const list = parent?.subMessages ?? session.messages
    const target = this.findToolMsg(list, event.toolUseId)
    if (!target) return
    target.toolResult = event.content
    target.toolResultIsError = event.isError ?? false
    target.toolStatus = event.isError ? 'error' : 'completed'
  }

  /**
   * Apply a sub-agent event to its parent tool's nested transcript, mirroring the
   * main-thread push/update/complete/text logic but scoped to `subMessages`.
   */
  private applyChildEvent(session: Session, parentToolUseId: string, event: NormalizedEvent): void {
    const parent = this.findToolMsg(session.messages, parentToolUseId)
    if (!parent) return
    if (!parent.subMessages) parent.subMessages = []
    const subs = parent.subMessages

    switch (event.type) {
      case 'tool_call':
        // Sub-agent tool calls are synthesized from assembled assistant messages,
        // which can be re-delivered (resume/replay); skip if we already have it.
        if (event.toolId && subs.some((m) => m.role === 'tool' && m.toolId === event.toolId)) break
        subs.push({
          id: nextMsgId(),
          role: 'tool',
          content: event.content ?? '',
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
            if (event.content !== undefined) m.content = event.content
            break
          }
        }
        break

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
        // Sub-agent text no longer streams; the assembled assistant_message is the
        // sole path. Dedup exact re-deliveries (resume/replay), but let consecutive
        // distinct texts land as separate blocks.
        if (!event.text) break
        const text = event.text
        const lastSub = subs[subs.length - 1]
        if (lastSub?.role === 'assistant' && !lastSub.toolName && lastSub.content === text) break
        subs.push({ id: nextMsgId(), role: 'assistant', content: text, timestamp: Date.now() })
        break
      }
    }
  }

  appendTextChunk(tabId: string, session: Session, text: string): void {
    const prev = this.streaming.text[tabId]
    this.streaming.text[tabId] = (prev ?? '') + text
    if (!session.isStreamingText) session.isStreamingText = true
  }

  commitPendingStream(tabId: string): void {
    const pendingText = this.streaming.text[tabId] ?? ''
    delete this.streaming.text[tabId]
    const session = this.deps.registry.sessionFor(tabId)
    if (session) session.isStreamingText = false
    if (!pendingText) return
    if (!session) return
    const lastMsg = session.messages[session.messages.length - 1]
    if (lastMsg?.role === 'assistant' && !lastMsg.toolName && !lastMsg.artifact && !lastMsg.workRef && !lastMsg.automationRef) {
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

  resetSessionRunState(session: Session): void {
    session.isStreamingText = false
    session.isReconnecting = false
    session.permissionQueue = []
    session.questionQueue = []
    session.permissionDenied = null
  }
}
