import type { PermissionOption, QuestionItem, RateLimitInfo, RequestExpiry, SessionStatus, WireNormalizedEvent } from '@solus/contracts/types'
import type { SessionHistoryPage, WireSessionLoadMessage } from '@solus/contracts/session-history'
import { planKey } from '@solus/contracts/types'
import type { DeviceBuildRef } from '@solus/contracts/device-types'
import { AgentPlans } from './agent-plans'

/**
 * One conversation's transcript as the native client shows it (plan 017
 * stage 3). It follows the Svelte reducer's rules (`session-event-reducer`,
 * `session-transcript`) for the rows this client renders, and keeps each item
 * an immutable object in a map: a streamed token replaces one item, so only
 * that row re-renders, and the order array changes only when a row is added.
 */

export type Delivery = 'sending' | 'queued' | 'sent' | 'failed'

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; delivery: Delivery; error: string | null; attachmentCount: number }
  | { kind: 'assistant'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      toolId: string
      toolName: string
      input: string | null
      status: 'running' | 'completed' | 'error'
      errorHead: string | null
      /** Rows a sub-agent wrote under this call. Shown as a count. */
      childCount: number
    }
  | { kind: 'notice'; id: string; text: string; tone: 'error' | 'info' }
  /** An app build the agent handed to the host; its row opens App builds. */
  | { kind: 'build'; id: string; build: DeviceBuildRef }
  | {
      kind: 'plan'
      id: string
      planId: string
      planToolUseId: string
      content: string
      filePath: string | null
      questionId: string | null
      options: PermissionOption[]
      /** `earlier`: read from history, where this client does not know the decision. */
      decision: 'pending' | 'accepted' | 'rejected' | 'earlier'
    }

/** What changed since the last read: rows replaced, rows added, or the chrome around them. */
export interface TranscriptChanges {
  items: string[]
  order: boolean
  meta: boolean
}

export interface PendingPermission {
  questionId: string
  toolName: string
  description: string | null
  options: PermissionOption[]
  /** Set when the request can no longer be answered. */
  expired?: RequestExpiry
}

export interface PendingQuestion {
  questionId: string
  questions: QuestionItem[]
  responseMode?: 'message'
  /** Set when the question can no longer be answered. */
  expired?: RequestExpiry
}

export interface QueuedPrompt {
  queueId: string
  text: string
  clientPromptId?: string
}

type PermissionDecision = Extract<WireNormalizedEvent, { type: 'permission_resolved' }>['decision']

export class TranscriptModel {
  order: readonly string[] = []
  readonly items = new Map<string, TranscriptItem>()
  /** Item ids changed since the last `takeChanges`; `orderChanged` when rows were added. */
  private changedItems = new Set<string>()
  private orderChanged = false
  private metaChanged = false

  status: SessionStatus = 'idle'
  agentSessionId: string | null = null
  permissions: readonly PendingPermission[] = []
  questions: readonly PendingQuestion[] = []
  rateLimit: RateLimitInfo | null = null
  queued: readonly QueuedPrompt[] = []
  /** Plans of sessions this conversation sent work to. */
  readonly agentPlans = new AgentPlans()
  /** Cursor for the next older page; null when the start of history is loaded. */
  olderCursor: string | null = null

  private nextId = 0
  private streamTarget: string | null = null
  private proseSinceUser = false
  private readonly settledTurns = new Set<string>()

  constructor(readonly sessionId: string) {}

  // ─── History ───

  /** The first page. Rows of the page replace nothing: this is a fresh model. */
  static fromHistory(sessionId: string, page: SessionHistoryPage): TranscriptModel {
    const model = new TranscriptModel(sessionId)
    model.order = model.rowsToItems(page.messages)
    model.olderCursor = page.before
    model.orderChanged = true
    model.proseSinceUser = true
    return model
  }

  /** An older page goes before everything already shown. */
  prependHistory(page: SessionHistoryPage): void {
    const older = this.rowsToItems(page.messages)
    this.order = [...older, ...this.order]
    this.olderCursor = page.before
    this.orderChanged = true
    this.metaChanged = true
  }

  private rowsToItems(rows: readonly WireSessionLoadMessage[]): string[] {
    const ids: string[] = []
    for (const row of rows) {
      // A sub-agent's rows are counted on the call that started it.
      if (row.parentToolUseId) this.countChild(row.parentToolUseId)
      else if (row.role === 'tool_result') this.applyHistoryResult(row)
      else {
        const id = this.historyItem(row)
        if (id) ids.push(id)
      }
    }
    return ids
  }

  /** One history row as an item; null for rows this client does not render yet
   *  (reasoning, activity). */
  private historyItem(row: WireSessionLoadMessage): string | null {
    const id = row.messageId ?? this.mintId('h')
    if (row.role === 'user') {
      this.items.set(id, { kind: 'user', id, text: row.content, delivery: 'sent', error: null, attachmentCount: row.imageAttachments?.length ?? 0 })
      return id
    }
    if (row.role === 'assistant' && row.content.trim()) {
      this.items.set(id, { kind: 'assistant', id, text: row.content })
      return id
    }
    if (row.role === 'tool' && row.toolId) {
      this.items.set(id, {
        kind: 'tool', id, toolId: row.toolId, toolName: row.toolName ?? 'Tool',
        input: row.toolInput ?? null,
        status: row.toolStatus === 'error' ? 'error' : row.toolStatus === 'running' ? 'running' : 'completed',
        errorHead: null, childCount: 0,
      })
      return id
    }
    if (row.role === 'plan' && row.planContent?.trim()) {
      return this.addPlanItem(id, {
        planToolUseId: row.planToolUseId ?? id,
        content: row.planContent,
        filePath: row.planFilePath ?? null,
        questionId: null,
        options: [],
        // A plan read from history is no longer awaiting this client.
        decision: 'earlier',
      }, false)
    }
    return null
  }

  private applyHistoryResult(row: WireSessionLoadMessage): void {
    if (!row.toolResultForId) return
    this.patchToolById(row.toolResultForId, false, (tool) => ({
      ...tool,
      status: row.status === 'error' ? 'error' : 'completed',
      errorHead: row.errorHead ?? null,
    }))
  }

  // ─── Live events ───

  apply(event: WireNormalizedEvent): void {
    if (this.status === 'interrupted' && DROPPED_WHILE_INTERRUPTED.has(event.type)) return
    if ('parentToolUseId' in event && event.parentToolUseId) {
      if (event.type === 'tool_call') this.countChild(event.parentToolUseId)
      return
    }
    // Each group answers whether it owned the event; anything else is not shown yet.
    if (this.applyStream(event) || this.applyTurn(event) || this.applyRequest(event)) return
    this.applyQueue(event)
  }

  private applyStream(event: WireNormalizedEvent): boolean {
    switch (event.type) {
      case 'session_init':
        this.agentSessionId = event.sessionId
        this.metaChanged = true
        return true
      case 'text_chunk':
        this.streamText(event.text)
        return true
      case 'assistant_message':
        // The final text of prose that already streamed is a boundary, not new text.
        this.addProseOnce(event.text)
        return true
      case 'tool_call':
        this.streamTarget = null
        this.append({
          kind: 'tool', id: this.mintId('t'), toolId: event.toolId, toolName: event.toolName,
          input: event.toolInput ?? null, status: 'running', errorHead: null, childCount: 0,
        })
        return true
      case 'tool_call_update':
        this.updateToolInput(event.toolId, event.toolInput)
        return true
      case 'tool_call_complete':
        this.completeTool(event)
        return true
      case 'tool_result':
        this.patchToolById(event.toolUseId, false, (tool) => ({ ...tool, status: event.status === 'error' ? 'error' : 'completed', errorHead: event.errorHead ?? null }))
        return true
      case 'user_message':
        this.applyUserMessage(event)
        return true
      case 'device_build_ready':
        // The build is what the turn produced: it shows when it is handed over.
        this.streamTarget = null
        this.append({ kind: 'build', id: this.mintId('b'), build: event.build })
        return true
      default:
        return false
    }
  }

  private applyTurn(event: WireNormalizedEvent): boolean {
    switch (event.type) {
      case 'status_change':
        this.setStatus(event.status)
        return true
      case 'task_complete':
        this.addProseOnce(event.result)
        this.clearRequests()
        return true
      case 'turn_settled':
        if (!this.settledTurns.has(event.turnId)) this.streamTarget = null
        this.settledTurns.add(event.turnId)
        return true
      case 'error':
        this.addNotice(`Error: ${event.message}`, 'error')
        return true
      case 'session_dead':
        this.addNotice('Error: the agent process ended unexpectedly.', 'error')
        return true
      case 'rate_limit':
        if (event.status === 'allowed' || event.isUsingOverage) return true
        this.rateLimit = event.info ?? { resetsAt: event.resetsAt, rateLimitType: event.rateLimitType, prompt: '', queuedPrompt: '' }
        this.clearRequests()
        this.metaChanged = true
        return true
      case 'rate_limit_resolved':
        this.setRateLimit(null)
        return true
      case 'plan':
        this.applyPlan(event)
        return true
      case 'plan_rejected':
        for (const [id, item] of this.items) {
          if (item.kind === 'plan' && item.planToolUseId === event.planToolUseId) this.replace({ ...item, decision: 'rejected' }, id)
        }
        return true
      default:
        return false
    }
  }

  private applyRequest(event: WireNormalizedEvent): boolean {
    switch (event.type) {
      case 'permission_request':
        if (this.permissions.some((request) => request.questionId === event.questionId)) return true
        this.permissions = [...this.permissions, {
          questionId: event.questionId,
          toolName: event.toolName,
          description: event.toolDescription ?? null,
          options: event.options,
        }]
        this.metaChanged = true
        return true
      case 'permission_resolved':
        // Nobody answered: the card stays, without its controls, to say why.
        if (event.expired) this.expireRequest(event.questionId, event.expired)
        else this.resolveRequest(event.questionId, event.decision)
        return true
      case 'question_request':
        if (this.questions.some((question) => question.questionId === event.questionId)) return true
        this.questions = [...this.questions, { questionId: event.questionId, questions: event.questions, responseMode: event.responseMode }]
        this.metaChanged = true
        return true
      case 'question_answered':
        this.resolveRequest(event.answer.questionId)
        return true
      case 'agent_conversation_update':
        this.agentPlans.apply(event.update)
        this.metaChanged = true
        return true
      case 'pending_input_sync':
        // The host's list of open requests replaces this client's. A message-mode
        // question is not in that list: it outlives its turn, so it stays.
        this.permissions = []
        this.questions = this.questions.filter((question) => question.responseMode === 'message')
        for (const pending of event.pendingInputEvents) {
          if (pending.type === 'permission_request' || pending.type === 'question_request' || pending.type === 'plan') this.apply(pending)
        }
        this.metaChanged = true
        return true
      default:
        return false
    }
  }

  private applyQueue(event: WireNormalizedEvent): void {
    switch (event.type) {
      case 'prompt_queued':
        if (this.queued.some((queued) => queued.queueId === event.queueId)) return
        this.queued = [...this.queued, { queueId: event.queueId, text: event.text, clientPromptId: event.clientPromptId }]
        if (event.clientPromptId) this.markDelivery(event.clientPromptId, 'queued')
        this.metaChanged = true
        return
      case 'prompt_dequeued':
        this.setQueued(this.queued.filter((queued) => queued.queueId !== event.queueId))
        return
      case 'prompt_queue_updated':
        this.setQueued(this.queued.map((queued) => (queued.queueId === event.queueId ? { ...queued, text: event.text } : queued)))
        return
      default:
        return
    }
  }

  private streamText(text: string): void {
    if (!text) return
    const target = this.streamTarget ? this.items.get(this.streamTarget) : undefined
    if (target?.kind === 'assistant') {
      this.replace({ ...target, text: target.text + text })
    } else {
      const id = this.mintId('a')
      this.append({ kind: 'assistant', id, text })
      this.streamTarget = id
    }
    this.proseSinceUser = true
  }

  /** Final text adds a row only when no prose streamed since the person spoke. */
  private addProseOnce(text: string): void {
    if (!this.proseSinceUser && text.trim()) {
      this.append({ kind: 'assistant', id: this.mintId('a'), text })
      this.proseSinceUser = true
    }
    this.streamTarget = null
  }

  private updateToolInput(toolId: string, input: string | undefined): void {
    if (input === undefined) return
    this.patchToolById(toolId, true, (tool) => ({ ...tool, input }))
  }

  private completeTool(event: Extract<WireNormalizedEvent, { type: 'tool_call_complete' }>): void {
    // Without an outcome Claude only finished streaming the input; the
    // result is the later execution boundary.
    if (!event.outcome && event.completedAtMs === undefined) return
    if (!event.toolId) return
    const failed = !!event.outcome?.error || (event.outcome?.exitCode ?? 0) !== 0
    this.patchToolById(event.toolId, true, (tool) => ({ ...tool, status: failed ? 'error' : 'completed', errorHead: event.outcome?.error ?? tool.errorHead }))
  }

  private applyPlan(event: Extract<WireNormalizedEvent, { type: 'plan' }>): void {
    if (!event.planContent.trim()) return
    this.streamTarget = null
    this.addPlanItem(this.mintId('p'), {
      planToolUseId: event.planToolUseId ?? event.questionId,
      content: event.planContent,
      filePath: event.planFilePath || null,
      questionId: event.questionId || null,
      options: event.options,
      decision: 'pending',
    }, true)
  }

  private countChild(parentToolUseId: string): void {
    this.patchToolById(parentToolUseId, false, (tool) => ({ ...tool, childCount: tool.childCount + 1 }))
  }

  // ─── Local state the client owns ───

  /** A prompt the user just sent, shown before the host echoes it. */
  addOptimisticUser(clientPromptId: string, text: string, delivery: Delivery = 'sending', attachmentCount = 0): void {
    if (this.items.has(clientPromptId)) return
    this.append({ kind: 'user', id: clientPromptId, text, delivery, error: null, attachmentCount })
    this.streamTarget = null
    this.proseSinceUser = false
  }

  markDelivery(clientPromptId: string, delivery: Delivery, error: string | null = null): void {
    const item = this.items.get(clientPromptId)
    if (item?.kind !== 'user') return
    if (item.delivery === delivery && item.error === error) return
    this.replace({ ...item, delivery, error })
  }

  setStatus(status: SessionStatus): void {
    if (this.status === status) return
    this.status = status
    if (status === 'idle') this.clearRequests()
    // A new turn: cards closed before it have said why; they leave.
    if (status === 'running' || status === 'connecting') {
      this.permissions = this.permissions.filter((request) => !request.expired)
      this.questions = this.questions.filter((question) => !question.expired)
    }
    this.metaChanged = true
  }

  setRateLimit(info: RateLimitInfo | null): void {
    this.rateLimit = info
    this.metaChanged = true
  }

  setQueued(queued: readonly QueuedPrompt[]): void {
    this.queued = queued
    this.metaChanged = true
  }

  addNotice(text: string, tone: 'error' | 'info'): void {
    this.streamTarget = null
    this.append({ kind: 'notice', id: this.mintId('n'), text, tone })
  }

  setPlanDecision(planId: string, decision: 'pending' | 'accepted' | 'rejected'): void {
    for (const [id, item] of this.items) {
      if (item.kind === 'plan' && item.planId === planId && item.decision !== decision) this.replace({ ...item, decision }, id)
    }
  }

  /** The open plan awaiting this session's decision, if any. */
  pendingPlan(): Extract<TranscriptItem, { kind: 'plan' }> | null {
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const item = this.items.get(this.order[index] ?? '')
      if (item?.kind === 'plan' && item.decision === 'pending') return item
    }
    return null
  }

  /** What changed since the last call: the store notifies exactly these. */
  takeChanges(): TranscriptChanges {
    const changes = { items: [...this.changedItems], order: this.orderChanged, meta: this.metaChanged }
    this.changedItems.clear()
    this.orderChanged = false
    this.metaChanged = false
    return changes
  }

  // ─── Internals ───

  private applyUserMessage(event: Extract<WireNormalizedEvent, { type: 'user_message' }>): void {
    // A sub-agent's report and a question answer are not the person's prompt.
    if (event.via === 'session-report' || event.via === 'question-answer') return
    this.streamTarget = null
    this.proseSinceUser = false
    if (event.clientPromptId) {
      this.queued = this.queued.filter((queued) => queued.clientPromptId !== event.clientPromptId)
      const existing = this.items.get(event.clientPromptId)
      if (existing) {
        this.markDelivery(event.clientPromptId, 'sent')
        return
      }
    }
    const attachmentCount = (event.imageAttachments?.length ?? 0) + (event.imageAttachmentRefs?.length ?? 0)
    this.append({ kind: 'user', id: event.clientPromptId ?? this.mintId('u'), text: event.text, delivery: 'sent', error: null, attachmentCount })
  }

  private addPlanItem(id: string, plan: Omit<Extract<TranscriptItem, { kind: 'plan' }>, 'kind' | 'id' | 'planId'>, append: boolean): string {
    const planId = planKey(this.agentSessionId ?? this.sessionId, plan.planToolUseId)
    for (const [existingId, item] of this.items) {
      if (item.kind === 'plan' && item.planId === planId) {
        // A live plan event for a plan history already showed makes it pending again.
        this.replace({ ...item, ...plan, decision: item.decision === 'pending' || item.decision === 'earlier' ? plan.decision : item.decision }, existingId)
        return existingId
      }
    }
    const item: TranscriptItem = { kind: 'plan', id, planId, ...plan }
    if (append) this.append(item)
    else this.items.set(id, item)
    return id
  }

  private resolveRequest(questionId: string, decision?: PermissionDecision): void {
    const before = this.permissions.length + this.questions.length
    this.permissions = this.permissions.filter((request) => request.questionId !== questionId)
    this.questions = this.questions.filter((question) => question.questionId !== questionId)
    if (this.permissions.length + this.questions.length !== before) this.metaChanged = true
    for (const [id, item] of this.items) {
      if (item.kind !== 'plan' || item.questionId !== questionId || item.decision !== 'pending') continue
      // Decided here or on another client: the host's resolution is the answer.
      this.replace({ ...item, decision: decision === 'denied' ? 'rejected' : 'accepted' }, id)
    }
  }

  /** The host no longer holds this request. A message-mode question is answered
   *  by a new message, so it never expires. */
  expireRequest(questionId: string, expiry: RequestExpiry): void {
    const permissions = this.permissions.map((request) => request.questionId === questionId ? { ...request, expired: expiry } : request)
    const questions = this.questions.map((question) =>
      question.questionId === questionId && question.responseMode !== 'message' ? { ...question, expired: expiry } : question)
    if (permissions.some((request, index) => request !== this.permissions[index])
      || questions.some((question, index) => question !== this.questions[index])) this.metaChanged = true
    this.permissions = permissions
    this.questions = questions
  }

  private clearRequests(): void {
    if (this.permissions.length === 0 && this.questions.every((question) => question.responseMode === 'message')) return
    this.permissions = []
    // A message-mode question is answered by a later prompt, so it outlives the turn.
    this.questions = this.questions.filter((question) => question.responseMode === 'message')
    this.metaChanged = true
  }

  /** The newest tool item for a provider tool id; `runningOnly` for in-flight updates. */
  private findTool(toolId: string, runningOnly = false): string | undefined {
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const id = this.order[index]
      const item = id ? this.items.get(id) : undefined
      if (item?.kind === 'tool' && item.toolId === toolId && (!runningOnly || item.status === 'running')) return id
    }
    for (const [id, item] of this.items) {
      if (item.kind === 'tool' && item.toolId === toolId && (!runningOnly || item.status === 'running')) return id
    }
    return undefined
  }

  private patchToolById(toolId: string, runningOnly: boolean, patch: (tool: Extract<TranscriptItem, { kind: 'tool' }>) => Extract<TranscriptItem, { kind: 'tool' }>): void {
    const id = this.findTool(toolId, runningOnly)
    const item = id ? this.items.get(id) : undefined
    if (id && item?.kind === 'tool') this.replace(patch(item), id)
  }

  private append(item: TranscriptItem): void {
    this.items.set(item.id, item)
    this.order = [...this.order, item.id]
    this.orderChanged = true
  }

  private replace(item: TranscriptItem, id = item.id): void {
    this.items.set(id, item)
    this.changedItems.add(id)
  }

  private mintId(prefix: string): string {
    this.nextId += 1
    return `${prefix}${this.nextId}`
  }
}

/** Output of a turn the user stopped; the host may still flush some of it. */
const DROPPED_WHILE_INTERRUPTED = new Set<WireNormalizedEvent['type']>([
  'text_chunk', 'assistant_message', 'thinking', 'tool_call', 'tool_call_update', 'tool_call_complete', 'plan',
])
