import { providerStartupAfter } from '@solus/client-core/provider-startup'
import type { ProviderStartup } from '@solus/contracts/provider-startup'
import { EMPTY_THREAD_HISTORY_META, applyHistoryPageMeta, type ThreadHistoryMeta } from "@t3tools/client-runtime/state/thread-history-merge"
import { backgroundCommandWake, type BackgroundCommandWake } from '@solus/client-core/background-command-wake'
import { agentActivityOfTool, type AgentActivity } from '@solus/contracts/agent-activity'
import type { BrowserSnapshotRef } from '@solus/contracts/browser-types'
import type { Activity, WorktreeOfferResolution } from '@solus/contracts/activity'
import type { McpAppReference } from '@solus/contracts/mcp-apps'
import type { SessionFolder } from '@solus/contracts/codebases'
import { stripSessionReferenceContext } from '@solus/contracts/injected-context'
import type { BackgroundTask, BackgroundTaskKind, ContextCompaction, PermissionOption, PromptSender, PromptVia, RateLimitInfo, RequestExpiry, SessionStatus, StatusCardState, ToolProgress, WireNormalizedEvent } from '@solus/contracts/types'
import type { SessionHistoryPage, WireSessionLoadMessage } from '@solus/contracts/session-history'
import { planKey } from '@solus/contracts/types'
import { settleSetupCard } from '@solus/contracts/setup-card'
import { AgentCards, isAgentConversationTool, type AgentItem } from './agent-cards'
import { promptImageAttachments, splitAttachedFiles, type MessageAttachment } from './message-attachments'
import { AgentPlans } from './agent-plans'
import { artifactFromCreated, artifactFromHistory, type ArtifactRender } from './artifacts'
import type { AgentSwitch } from './provider-handoff'
import { hasOwnCard, type PendingPermission, type PendingQuestion, type QueuedPrompt } from './pending-requests'
import { ToolRowIndex, type ToolItem } from './tool-item'

export type { PendingPermission, PendingQuestion, QueuedPrompt } from './pending-requests'
export type { ToolItem } from './tool-item'

/**
 * One conversation's transcript as the native client shows it (plan 017
 * stage 3). It follows the Svelte reducer's rules (`session-event-reducer`,
 * `session-transcript`) for the rows this client renders, and keeps each item
 * an immutable object in a map: a streamed token replaces one item, so only
 * that row re-renders, and the order array changes only when a row is added.
 */

// A live edit replaces its item. Only the unchanged saved item can reuse its host body.
export const savedTurnItems = new WeakMap<TranscriptItem, NonNullable<WireSessionLoadMessage['turnItem']>>()

export type Delivery = 'sending' | 'queued' | 'sent' | 'failed'

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; sender?: PromptSender; via?: PromptVia; timestamp?: number; sourceSessionId?: string; delivery: Delivery; waitsForTurn?: boolean; error: string | null; attachments: readonly MessageAttachment[]; backgroundCommand?: BackgroundCommandWake }
  | { kind: 'assistant'; id: string; text: string; replyHtmlLayout?: import('@solus/contracts/session-history').ReplyHtmlLayout[]; streaming?: boolean; timestamp?: number; sourceSessionId?: string; forkPointId?: string }
  | { kind: 'browser_snapshot'; id: string; snapshot: BrowserSnapshotRef }
  | { kind: 'image'; id: string; path: string }
  | ToolItem
  | { kind: 'host_question'; id: string; question: PendingQuestion }
  /** Another Solus session this conversation sent work to (`agent-cards.ts`). */
  | AgentItem
  | { kind: 'notice'; id: string; text: string; tone: 'error' | 'info' }
  /** An HTML render the agent showed (`artifacts.ts`). */
  | ({ kind: 'artifact'; id: string } & ArtifactRender)
  /** A context compaction: running from its start event, settled by its stop. */
  | { kind: 'compaction'; id: string; compaction: ContextCompaction }
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
  /** The agent works in a worktree the session is not bound to. The host
   *  records the offer and its answer as activity (docs/worktree-names.md). */
  | {
      kind: 'worktree_offer'
      id: string
      offerId: string
      path: string
      branch: string | null
      /** Null while the user has not answered. */
      resolution: WorktreeOfferResolution | null
    }
  /** The host handed the session's thread to another provider (plans/021). */
  | { kind: 'handoff'; id: string; activity: AgentSwitch }
  | { kind: 'fork'; id: string; activity: Extract<Activity, { kind: 'forked' }> }
  | { kind: 'setup'; id: string; card: StatusCardState }
  /** `sessionId` is the session the app's activity belongs to: the app is read through it. */
  | { kind: 'mcp_app'; id: string; activityId: string; sessionId: string; app: McpAppReference }

/** What changed since the last read: rows replaced, rows added, or the chrome around them. */
export interface TranscriptChanges {
  items: string[]
  order: boolean
  meta: boolean
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
  providerStartup: ProviderStartup | null = null
  latestSettledTurnId: string | null = null

  setProviderStartup(startup: ProviderStartup | null): void {
    if (this.providerStartup === startup) return
    this.providerStartup = startup
    this.metaChanged = true
  }
  /** Background work of the session runs on its host, held or not (`background_work`). */
  backgroundWorkRunning = false
  /** The running tasks. `kind` is set when the host named the task; an older host does not. */
  backgroundTasks: readonly { taskId: string; kind?: BackgroundTaskKind; description?: string }[] = []
  /** The folders the session works in besides its working directory, as its host last reported them (`session_folders`). */
  sessionFolders: readonly SessionFolder[] = []
  agentRows: readonly (AgentItem | ToolItem)[] = []

  readonly agentTurnIds = new Map<string, string | null>()
  latestPromptId: string | null = null

  private indexAgentTurn(item: TranscriptItem): void {
    if (item.kind === 'user' && item.delivery === 'sent') this.latestPromptId = item.id
    else if (item.kind === 'agent' || (item.kind === 'tool' && item.subagent))
      this.agentTurnIds.set(item.id, this.latestPromptId)
  }

  private indexPageTurns(ids: readonly string[]): void {
    for (const id of ids) {
      const item = this.items.get(id)
      if (item) this.indexAgentTurn(item)
    }
  }

  private trackAgent(item: TranscriptItem): void {
    if (item.kind !== 'agent' && !(item.kind === 'tool' && item.subagent)) return
    const index = this.agentRows.findIndex(agent => agent.id === item.id)
    if (index === -1) this.agentRows = [...this.agentRows, item]
    else {
      const previous = this.agentRows[index]
      if (previous === item || (
        previous?.kind === 'tool' && item.kind === 'tool'
        && previous.report === item.report && previous.status === item.status
        && previous.input === item.input && previous.completedAt === item.completedAt
      )) return
      const next = this.agentRows.slice()
      next[index] = item
      this.agentRows = next
    }
    this.metaChanged = true
  }

  /** What the agent does now, by the host's rules (`session-activity.ts`). A
   *  provider sub-agent's own transcript is where the client reads it: the
   *  host sends `session.activityChanged` only for top-level work. Live only. */
  activity: AgentActivity | null = null
  permissions: readonly PendingPermission[] = []
  questions: readonly PendingQuestion[] = []
  rateLimit: RateLimitInfo | null = null
  queued: readonly QueuedPrompt[] = []
  /** Plans of sessions this conversation sent work to. */
  readonly agentPlans = new AgentPlans()
  /** Cursor for the next older page; null when the start of history is loaded. */
  history: ThreadHistoryMeta = EMPTY_THREAD_HISTORY_META
  get olderCursor(): string | null { return this.history.historyCursor }

  private nextId = 0
  /** Orchestration calls a card stands for: kept out of the feed unless they fail. */
  private readonly heldTools = new Set<string>()
  /** Providers normally give each tool a unique id. A repeated id uses timeline order. */
  private readonly toolRows = new ToolRowIndex()
  /** While a history page is read, the ids it places, in order. */
  private collecting: string[] | null = null
  /** History rows whose call an older page holds: a tool result or a child
   *  agent's row, when a long turn's page starts after its call. */
  private unresolvedRows: WireSessionLoadMessage[] = []
  private readonly agentCards = new AgentCards({
    get: (id) => {
      const item = this.items.get(id)
      return item?.kind === 'agent' ? item : undefined
    },
    add: (item) => this.place(item),
    update: (item) => this.replace(item),
  })
  private streamTarget: string | null = null
  /** The compaction that started and has not stopped. */
  get isCompacting(): boolean { return this.runningCompactionId !== null }
  private runningCompactionId: string | null = null
  private proseSinceUser = false
  private lastResponseId: string | null = null
  private readonly settledTurns = new Set<string>()
  /** The newest saved revision applied per artifact work, so a repeated update adds no card. */
  private readonly artifactUpdates = new Map<string, string>()

  constructor(readonly sessionId: string) {}

  // ─── History ───

  /** The first page. Rows of the page replace nothing: this is a fresh model. */
  static fromHistory(sessionId: string, page: SessionHistoryPage): TranscriptModel {
    const model = new TranscriptModel(sessionId)
    model.order = model.rowsToItems(page)
    model.indexPageTurns(model.order)
    model.history = { ...EMPTY_THREAD_HISTORY_META, historyCursor: page.before, hasMoreHistory: page.before !== null }
    model.orderChanged = true
    model.proseSinceUser = true
    return model
  }

  /** An older page goes before everything already shown. */
  prependHistory(page: SessionHistoryPage): void {
    const older = this.rowsToItems(page)
    const latest = this.latestPromptId
    // An earlier page can supply the missing prompt for the first agents already shown.
    const unassigned = [...this.agentTurnIds].filter(([, prompt]) => prompt === null)
    this.latestPromptId = null
    this.indexPageTurns(older)
    if (this.latestPromptId) for (const [id] of unassigned) this.agentTurnIds.set(id, this.latestPromptId)
    this.latestPromptId = latest ?? this.latestPromptId
    this.order = [...older, ...this.order]
    this.history = applyHistoryPageMeta(this.history, { nextCursor: page.before, hasMoreHistory: page.before !== null })
    this.orderChanged = true
    this.metaChanged = true
  }

  /** A page's rows, then the rows earlier pages kept for their calls. While
   *  older pages remain, a row whose call is not read yet waits for them. */
  private rowsToItems(page: SessionHistoryPage): string[] {
    const rows = this.unresolvedRows.length ? page.messages.concat(this.unresolvedRows) : page.messages
    this.unresolvedRows = []
    // Claude stores a call and its result as separate rows. Read the exchange
    // facts at the call so cards retain their turn, just as for inline results.
    const resultsByTool = new Map(rows.flatMap((row) =>
      row.role === 'tool_result' && row.toolResultForId
        ? [[row.toolResultForId, row.agentConversationResults] as const]
        : []))
    const ids: string[] = []
    this.collecting = ids
    for (const row of rows) {
      const callId = row.parentToolUseId ?? (row.role === 'tool_result' ? row.toolResultForId : undefined)
      if (callId && page.before !== null && !this.toolRows.find(this, callId)) {
        this.unresolvedRows.push(row)
        continue
      }
      if (row.parentToolUseId) {
        const { parentToolUseId, ...message } = row
        this.childTranscript(parentToolUseId, (child) => {
          child.order = [...child.order, ...child.rowsToItems({ messages: [message], before: null })]
        })
      } else if (row.role === 'tool_result') this.applyHistoryResult(row)
      else if (row.activity?.kind === 'worktree_offer_decided') this.setWorktreeOfferResolution(row.activity.offerId, row.activity.resolution)
      else {
        const results = row.role === 'tool' && row.toolId ? resultsByTool.get(row.toolId) : undefined
        const id = this.historyItem(results && !row.agentConversationResults ? { ...row, agentConversationResults: results } : row)
        if (id) {
          ids.push(id)
          const item = this.items.get(id)
          if (item && row.turnItem) savedTurnItems.set(item, row.turnItem)
          if (item) this.trackAgent(item)
        }
      }
    }
    this.collecting = null
    return ids
  }

  /** A row added now: at the end of the feed, or in the history page being read. */
  private place(item: TranscriptItem): void {
    if (this.collecting) {
      this.items.set(item.id, item)
      this.trackAgent(item)
      this.collecting.push(item.id)
    } else {
      this.append(item)
    }
  }

  /** One history row as an item; null for rows this client does not render yet
   *  (reasoning, most activity). */
  private historyItem(row: WireSessionLoadMessage): string | null {
    const body = row.turnItem
    if (body?.type === 'user_message' || body?.type === 'assistant_message') row = { ...row, content: body.text }
    else if (body?.type === 'dynamic_tool' && body.input !== null && row.toolInput === undefined) {
      row = { ...row, toolInput: JSON.stringify(body.input) }
    }
    if (row.activity?.kind === 'mcp_app') return this.addMcpApp(row.activity, false)
    if (row.activity?.kind === 'worktree_offered') return this.addWorktreeOffer(row.activity, false)
    if (row.activity?.kind === 'agent_switched' || row.activity?.kind === 'forked') return this.addDivider(row.activity, false)
    if (row.activity?.kind === 'stopped') return this.addSessionEvent(row.activity, false)
    if (row.activity) return null
    const id = row.messageId ?? this.mintId('h')
    if (row.compaction) {
      this.items.set(id, { kind: 'compaction', id, compaction: row.compaction })
      return id
    }
    if (row.role === 'user') {
      const backgroundCommand = row.attachedFilePaths ? null : backgroundCommandWake(row.content)
      // A [session report] or notice is the orchestrator's, not the person's: it settles a card.
      if (!row.attachedFilePaths && !backgroundCommand && this.agentCards.applyUserRow(row.content, row.timestamp)) return null
      this.agentCards.closeTurn()
      if (backgroundCommand) {
        this.items.set(id, { kind: 'user', id, sender: row.sender, text: row.content, timestamp: row.timestamp, sourceSessionId: row.sourceSessionId, delivery: 'sent', error: null, attachments: [], backgroundCommand })
        return id
      }
      const { text, files } = splitAttachedFiles(row.attachedFilePaths ? row.content : stripSessionReferenceContext(row.content), row.attachedFilePaths)
      this.items.set(id, { kind: 'user', id, sender: row.sender, text, timestamp: row.timestamp, sourceSessionId: row.sourceSessionId, delivery: 'sent', error: null, attachments: [...promptImageAttachments(row.imageAttachments, row.imageAttachmentRefs), ...files] })
      return id
    }
    if (row.role === 'assistant' && row.content.trim()) {
      this.items.set(id, { kind: 'assistant', id, text: row.content, ...(row.replyHtmlLayout && { replyHtmlLayout: row.replyHtmlLayout }), timestamp: row.timestamp, sourceSessionId: row.sourceSessionId, forkPointId: row.forkPointId })
      return id
    }
    if (row.role === 'tool' && row.toolId) {
      this.toolRows.add(row.toolId, id)
      const toolName = row.toolName ?? 'Tool'
      const status = row.toolStatus === 'error' ? 'error' : row.toolStatus === 'running' ? 'running' : 'completed'
      this.items.set(id, {
        kind: 'tool', id, toolId: row.toolId, toolName, timestamp: row.timestamp,
        input: row.toolInput ?? null,
        ...(row.toolInputKey && { toolInputKey: row.toolInputKey }),
        ...(row.viewedImagePath && { viewedImagePath: row.viewedImagePath }),
        status,
        errorHead: null, childCount: 0,
        subagent: row.isSubagent ? row.subagentType ?? 'agent' : subagentFromToolName(toolName),
        report: row.report ?? null,
        images: row.toolImages,
        audio: row.toolAudio,
        leftOut: row.toolLeftOut,
        secretOutcomes: row.secretOutcomes,
      })
      if (!isAgentConversationTool(toolName)) return id
      this.agentCards.applyToolRow(toolName, row.toolInput, row.agentConversationResults ?? [], row.timestamp)
      if (status === 'error') return id
      this.heldTools.add(id)
      return null
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
    const toolId = this.toolRows.find(this, row.toolResultForId)
    const tool = toolId ? this.items.get(toolId) : undefined
    if (tool?.kind === 'tool') {
      const render = artifactFromHistory(tool.toolName, row)
      if (render) this.place({ kind: 'artifact', id: this.mintId('r'), ...render })
    }
    this.patchToolById(row.toolResultForId, false, (tool) => ({
      ...tool,
      status: row.status === 'error' ? 'error' : 'completed',
      errorHead: row.errorHead ?? null,
      report: row.report ?? tool.report,
      ...(tool.subagent && row.timestamp !== undefined && { completedAt: row.timestamp }),
      images: row.toolImages ?? tool.images,
      audio: row.toolAudio ?? tool.audio,
      leftOut: row.toolLeftOut ?? tool.leftOut,
      secretOutcomes: row.secretOutcomes ?? tool.secretOutcomes,
    }))
  }

  // ─── Live events ───

  apply(event: WireNormalizedEvent): void {
    if (this.status === 'interrupted' && DROPPED_WHILE_INTERRUPTED.has(event.type)) return
    if ('parentToolUseId' in event && event.parentToolUseId) {
      const { parentToolUseId, ...childEvent } = event
      this.childTranscript(parentToolUseId, (child) => child.apply(childEvent))
      return
    }
    this.setProviderStartup(providerStartupAfter(this.providerStartup, event) ?? null)
    this.trackActivity(event)
    // The sub-agent's last tool goes on its call; the turn's task list below reads the same event.
    if (event.type === 'background_task_progress') this.applyBackgroundProgress(event)
    if (event.type === 'browser_snapshot_captured') {
      this.finishStream()
      this.append({ kind: 'browser_snapshot', id: this.mintId('snapshot'), snapshot: event.snapshot })
      return
    }
    // Each group answers whether it owned the event; anything else is not shown yet.
    if (this.applyStream(event) || this.applyArtifact(event) || this.applyTurn(event) || this.applyRequest(event)) return
    this.applyQueue(event)
  }

  private applyStream(event: WireNormalizedEvent): boolean {
    switch (event.type) {
      case 'session_init':
        this.metaChanged = true
        return true
      case 'text_chunk':
        this.streamText(event.text)
        return true
      case 'assistant_message':
        // The final text of prose that already streamed is a boundary, not new text.
        this.addProseOnce(event.text)
        return true
      case 'tool_call': {
        this.finishStream()
        // A client that joins a running turn reads its history, then the host
        // replays the turn: a call history holds is the same row, live again.
        const loadedId = this.toolRows.find(this, event.toolId)
        const loaded = loadedId ? this.items.get(loadedId) : undefined
        if (loadedId && loaded?.kind === 'tool' && this.order.indexOf(loadedId) > this.order.indexOf(this.latestPromptId ?? '')) {
          this.replace({ ...loaded, status: 'running', input: event.toolInput ?? loaded.input }, loadedId)
          return true
        }
        const item: TranscriptItem = {
          kind: 'tool', id: this.mintId('t'), toolId: event.toolId, toolName: event.toolName,
          input: event.toolInput ?? null, status: 'running', errorHead: null, childCount: 0,
          subagent: event.isSubagent ? event.subagentType ?? 'agent' : subagentFromToolName(event.toolName),
          report: null,
        }
        this.toolRows.add(event.toolId, item.id)
        if (isAgentConversationTool(event.toolName)) {
          // The host's dispatch update draws the card; the call shows only if it fails.
          this.items.set(item.id, item)
          this.heldTools.add(item.id)
        } else {
          this.append(item)
        }
        return true
      }
      case 'tool_call_update':
        this.updateToolInput(event.toolId, event.toolInput)
        if (event.toolImages || event.toolAudio || event.toolLeftOut) {
          this.patchToolById(event.toolId, true, (tool) => ({
            ...tool,
            images: event.toolImages ?? tool.images,
            audio: event.toolAudio ?? tool.audio,
            leftOut: event.toolLeftOut ?? tool.leftOut,
          }))
        }
        return true
      case 'tool_call_complete':
        this.completeTool(event)
        return true
      case 'tool_progress':
        this.applyToolProgress(event)
        return true
      case 'tool_result':
        this.patchToolById(event.toolUseId, false, (tool) => ({
          ...tool,
          progress: undefined,
          status: event.status === 'error' ? 'error' : 'completed',
          errorHead: event.errorHead ?? null,
          images: event.toolImages ?? tool.images,
          audio: event.toolAudio ?? tool.audio,
          leftOut: event.toolLeftOut ?? tool.leftOut,
          secretOutcomes: event.secretOutcomes ?? tool.secretOutcomes,
        }))
        return true
      case 'subagent_running':
        this.patchToolById(event.toolUseId, false, tool => ({ ...tool, status: 'running', completedAt: undefined, report: null }))
        return true
      case 'subagent_report':
        this.patchToolById(event.toolUseId, false, (tool) => ({
          ...tool,
          report: event.text,
          status: event.isError ? 'error' : 'completed',
          completedAt: tool.completedAt ?? Date.now(),
        }))
        return true
      case 'user_message':
        this.applyUserMessage(event)
        return true
      case 'context_compaction':
        this.applyCompaction(event)
        return true
      case 'activity':
        this.applyActivity(event.activity)
        return true
      default:
        return false
    }
  }

  private applyArtifact(event: WireNormalizedEvent): boolean {
    if (event.type === 'artifact_created') {
      if (event.kind === 'image' && event.path) this.append({ kind: 'image', id: this.mintId('image'), path: event.path })
      const render = artifactFromCreated(event)
      if (render) this.append({ kind: 'artifact', id: this.mintId('r'), ...render })
      return true
    }
    if (event.type !== 'work_updated') return false
    this.applyWorkUpdate(event)
    return true
  }

  private applyTurn(event: WireNormalizedEvent): boolean {
    switch (event.type) {
      case 'status_card': {
        const id = `setup:${event.card.id}`
        const item: TranscriptItem = { kind: 'setup', id, card: event.card }
        if (this.items.has(id)) this.replace(item)
        else this.append(item)
        // The status pill names the setup step that runs now.
        this.metaChanged = true
        return true
      }
      case 'status_change':
        this.setStatus(event.status)
        return true
      case 'session_folders':
        this.sessionFolders = event.folders
        this.metaChanged = true
        return true
      case 'background_task_started':
      case 'background_task_progress': {
        const previous = this.backgroundTasks.find(task => task.taskId === event.taskId)
        const description = event.description ?? previous?.description
        const kind = (event.type === 'background_task_started' ? event.kind : undefined) ?? previous?.kind
        if (!previous || (description && previous.description !== description) || kind !== previous.kind) {
          this.backgroundTasks = [...this.backgroundTasks.filter(task => task !== previous), {taskId: event.taskId, ...(kind && {kind}), ...(description && {description})}]
          this.metaChanged = true
        }
        return true
      }
      case 'background_task_settled':
        if (event.toolUseId) {
          const id = this.toolRows.find(this, event.toolUseId, true)
          const tool = id ? this.items.get(id) : undefined
          if (tool?.kind === 'tool' && tool.subagent) {
            this.replace({ ...tool, status: event.status === 'completed' ? 'completed' : 'error', completedAt: Date.now() })
          }
        }
        this.backgroundTasks = this.backgroundTasks.filter(task => task.taskId !== event.taskId)
        this.metaChanged = true
        return true
      case 'background_work':
        this.setBackgroundWorkRunning(event.running)
        return true
      case 'task_complete':
        this.dropRunningCompaction()
        this.addProseOnce(event.result)
        const response = this.lastResponseId ? this.items.get(this.lastResponseId) : undefined
        if (response?.kind === 'assistant' && event.forkPointId) {
          this.replace({ ...response, forkPointId: event.forkPointId, sourceSessionId: event.sessionId })
        }
        this.clearRequests()
        return true
      case 'turn_settled':
        if (!this.settledTurns.has(event.turnId)) {
          this.finishStream()
          this.latestSettledTurnId = event.turnId
          this.metaChanged = true
        }
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

  /** Keep open host questions at their event positions when the host resends its pending list. */
  private setQuestions(next: readonly PendingQuestion[]): void {
    for (const question of this.questions) {
      if (!hasOwnCard(question) || next.some(q => q.questionId === question.questionId && hasOwnCard(q))) continue
      const id = `host-question:${question.questionId}`
      this.items.delete(id)
      this.order = this.order.filter(key => key !== id)
      this.orderChanged = true
    }
    for (const question of next) {
      if (!hasOwnCard(question)) continue
      const id = `host-question:${question.questionId}`
      const previous = this.items.get(id)
      if (previous?.kind === 'host_question' && previous.question === question) continue
      const item = { kind: 'host_question' as const, id, question }
      if (previous) this.replace(item)
      else {
        this.finishStream()
        this.append(item)
      }
    }
    this.questions = next
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
          ...(event.guestTurn && { guestTurn: true as const }),
          ...(event.supportsFeedback && { supportsFeedback: true as const }),
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
        this.setQuestions([...this.questions, pendingQuestion(event)])
        this.metaChanged = true
        return true
      case 'question_answered':
        this.resolveRequest(event.answer.questionId)
        return true
      case 'agent_conversation_update':
        this.agentPlans.apply(event.update)
        this.agentCards.apply(event.update)
        this.metaChanged = true
        return true
      case 'pending_input_sync':
        // The host's list of open requests replaces this client's. A message-mode
        // question is not in that list: it outlives its turn, so it stays.
        this.permissions = []
        const questions = this.questions.filter(question => question.responseMode === 'message')
        for (const pending of event.pendingInputEvents) {
          if (pending.type === 'question_request') {
            if (!questions.some(question => question.questionId === pending.questionId)) questions.push(pendingQuestion(pending))
          } else if (pending.type === 'permission_request' || pending.type === 'plan') this.apply(pending)
        }
        this.setQuestions(questions)
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

  private finishStream(): void {
    const item = this.streamTarget ? this.items.get(this.streamTarget) : undefined
    this.streamTarget = null
    if (item?.kind === 'assistant' && item.streaming) this.replace({ ...item, streaming: false })
  }

  private streamText(text: string): void {
    if (!text) return
    const target = this.streamTarget ? this.items.get(this.streamTarget) : undefined
    if (target?.kind === 'assistant') {
      this.replace({ ...target, text: target.text + text })
    } else {
      const id = this.mintId('a')
      this.append({ kind: 'assistant', id, text, streaming: true })
      this.streamTarget = id
      this.lastResponseId = id
    }
    this.proseSinceUser = true
  }

  /** Final text adds a row only when no prose streamed since the person spoke. */
  private addProseOnce(text: string): void {
    if (!this.proseSinceUser && text.trim()) {
      const id = this.mintId('a')
      this.append({ kind: 'assistant', id, text })
      this.lastResponseId = id
      this.proseSinceUser = true
    }
    this.finishStream()
  }

  /** A saved revision of an artifact work is a new render. The host can report
   *  a cloud-owned save as `doc`, so an earlier render of the work also counts. */
  private applyWorkUpdate(event: Extract<WireNormalizedEvent, { type: 'work_updated' }>): void {
    let earlier: Extract<TranscriptItem, { kind: 'artifact' }> | undefined
    for (const item of this.items.values()) {
      if (item.kind === 'artifact' && item.workId === event.workId) earlier = item
    }
    if ((event.docType !== 'artifact' && !earlier) || !event.contentVersion) return
    const applied = this.artifactUpdates.get(event.workId)
    if (applied !== undefined && applied >= event.updatedAt) return
    this.artifactUpdates.set(event.workId, event.updatedAt)
    this.append({
      kind: 'artifact',
      id: this.mintId('r'),
      title: event.title || earlier?.title || 'Artifact',
      workId: event.workId,
      contentVersion: event.contentVersion,
      ...(event.layout && { layout: event.layout }),
    })
  }

  private updateToolInput(toolId: string, input: string | undefined): void {
    if (input === undefined) return
    this.patchToolById(toolId, true, (tool) => ({ ...tool, input }))
  }

  /** The call's own card, or the card inside the provider sub-agent that ran it. Only a running card takes progress. */
  private applyToolProgress(event: Extract<WireNormalizedEvent, { type: 'tool_progress' }>): void {
    if (this.hasRunningTool(event.toolUseId)) {
      const progress: ToolProgress = { progress: event.progress }
      if (event.total !== undefined) progress.total = event.total
      if (event.message !== undefined) progress.message = event.message
      this.patchToolById(event.toolUseId, true, (tool) => ({ ...tool, progress }))
      return
    }
    for (const item of this.items.values()) {
      if (item.kind === 'tool' && item.children?.hasRunningTool(event.toolUseId)) {
        this.childTranscript(item.toolId, (child) => child.apply(event))
        return
      }
    }
  }

  private trackActivity(event: WireNormalizedEvent): void {
    if (event.type === 'thinking') {
      if (event.state !== 'stop') this.activity = 'think'
    } else if (event.type === 'tool_call') {
      // A question tool is the Input state, not an activity: it changes nothing.
      this.activity = agentActivityOfTool(event.toolName) ?? this.activity
    } else if (event.type === 'text_chunk') {
      this.activity = 'reply'
    } else if (event.type === 'turn_settled') {
      this.activity = null
    }
  }

  /** A background sub-agent reports its last tool on the call that started it. */
  private applyBackgroundProgress(event: Extract<WireNormalizedEvent, { type: 'background_task_progress' }>): void {
    const { toolUseId, lastToolName } = event
    if (!toolUseId || !lastToolName) return
    const id = this.toolRows.find(this, toolUseId, true)
    const item = id ? this.items.get(id) : undefined
    if (!id || item?.kind !== 'tool' || !item.subagent || item.lastToolName === lastToolName) return
    this.replace({ ...item, lastToolName }, id)
  }

  hasRunningTool(toolId: string): boolean {
    return this.toolRows.find(this, toolId, true) !== undefined
  }

  private completeTool(event: Extract<WireNormalizedEvent, { type: 'tool_call_complete' }>): void {
    // Claude's input arrives whole when it finishes streaming: a sub-agent's name is in it.
    this.updateToolInput(event.toolId, event.toolInput)
    // Without an outcome Claude only finished streaming the input; the
    // result is the later execution boundary.
    if (!event.outcome && event.completedAtMs === undefined) return
    const failed = !!event.outcome?.error || (event.outcome?.exitCode ?? 0) !== 0
    this.patchToolById(event.toolId, true, (tool) => ({ ...tool, status: failed ? 'error' : 'completed', errorHead: event.outcome?.error ?? tool.errorHead }))
  }

  private applyPlan(event: Extract<WireNormalizedEvent, { type: 'plan' }>): void {
    if (!event.planContent.trim()) return
    this.finishStream()
    this.addPlanItem(this.mintId('p'), {
      planToolUseId: event.planToolUseId ?? event.questionId,
      content: event.planContent,
      filePath: event.planFilePath || null,
      questionId: event.questionId || null,
      options: event.options,
      decision: 'pending',
    }, true)
  }

  // ─── Local state the client owns ───

  /** A prompt the user just sent, shown before the host echoes it. */
  addOptimisticUser(clientPromptId: string, text: string, delivery: Delivery = 'sending', attachments: readonly MessageAttachment[] = [], waitsForTurn = false, timestamp?: number): void {
    if (this.items.has(clientPromptId)) return
    this.append({ kind: 'user', id: clientPromptId, text, timestamp, delivery, error: null, attachments, ...(waitsForTurn && { waitsForTurn }) })
    if (!waitsForTurn) {
      this.agentCards.closeTurn()
      this.finishStream()
      this.proseSinceUser = false
      this.lastResponseId = null
    }
  }

  /** The files of a sent prompt, once the uploads it waited for land. */
  setOptimisticAttachments(clientPromptId: string, attachments: readonly MessageAttachment[]): void {
    const item = this.items.get(clientPromptId)
    if (item?.kind !== 'user') return
    this.replace({ ...item, attachments })
  }

  /** A prompt that never left this device: it goes back to the composer. */
  dropOptimisticUser(clientPromptId: string): void {
    const item = this.items.get(clientPromptId)
    if (item?.kind !== 'user' || item.delivery !== 'sending') return
    this.items.delete(clientPromptId)
    this.order = this.order.filter((each) => each !== clientPromptId)
    this.orderChanged = true
  }

  markDelivery(clientPromptId: string, delivery: Delivery, error: string | null = null): void {
    const item = this.items.get(clientPromptId)
    if (item?.kind !== 'user') return
    if (item.delivery === delivery && item.error === error) return
    if (delivery === "sent" && item.delivery !== "sent") this.latestPromptId = item.id
    this.replace({ ...item, delivery, error })
  }

  setBackgroundWorkRunning(running: boolean, taskIds?: readonly string[], namedTasks?: readonly BackgroundTask[]): void {
    if (taskIds || !running) {
      this.backgroundTasks = running
        ? (taskIds ?? []).map(taskId => namedTasks?.find(task => task.taskId === taskId) ?? this.backgroundTasks.find(task => task.taskId === taskId) ?? {taskId})
        : []
      this.metaChanged = true
    }
    if (this.backgroundWorkRunning === running) return
    this.backgroundWorkRunning = running
    this.metaChanged = true
  }

  setStatus(status: SessionStatus): void {
    if (this.status === status) return
    this.status = status
    if (status !== 'connecting' && status !== 'running') this.setProviderStartup(null)
    if (status !== 'connecting') this.settleSetupCards(status)
    if (status === 'idle' || status === 'interrupted') this.finishStream()
    if (status === 'idle') this.clearRequests()
    if (status === 'interrupted') this.settleInterruptedTools()
    // A running divider must not stay after the work stops.
    if (status !== 'running' && status !== 'connecting') this.dropRunningCompaction()
    // A new turn: cards closed before it have said why; they leave.
    if (status === 'running' || status === 'connecting') {
      this.permissions = this.permissions.filter((request) => !request.expired)
      this.setQuestions(this.questions.filter((question) => !question.expired))
    }
    this.metaChanged = true
  }

  /**
   * The same divider rules as the desktop reducer (`session-event-reducer`): a
   * start draws a running divider, its stop settles it in place, and a failed
   * compaction leaves none. Claude settles one compaction twice, so a stop with
   * no running divider updates the divider just drawn; the record's token
   * counts win.
   */
  private applyCompaction(event: Extract<WireNormalizedEvent, { type: 'context_compaction' }>): void {
    if (event.state === 'start') {
      if (this.runningCompactionId) return
      this.finishStream()
      const id = this.mintId('c')
      this.runningCompactionId = id
      this.append({ kind: 'compaction', id, compaction: { isRunning: true } })
      return
    }
    if (event.failed) {
      this.dropRunningCompaction()
      return
    }
    const compaction: ContextCompaction = {}
    if (event.trigger) compaction.trigger = event.trigger
    if (event.preTokens !== undefined) compaction.preTokens = event.preTokens
    if (event.postTokens !== undefined) compaction.postTokens = event.postTokens
    const runningId = this.runningCompactionId
    if (runningId) this.metaChanged = true
    this.runningCompactionId = null
    if (runningId && this.items.has(runningId)) {
      this.replace({ kind: 'compaction', id: runningId, compaction })
      return
    }
    const lastId = this.order.at(-1)
    const last = lastId ? this.items.get(lastId) : undefined
    if (last?.kind === 'compaction') {
      this.replace({
        ...last,
        compaction: event.preTokens !== undefined ? { ...last.compaction, ...compaction } : { ...compaction, ...last.compaction },
      })
      return
    }
    this.finishStream()
    this.append({ kind: 'compaction', id: this.mintId('c'), compaction })
  }

  private dropRunningCompaction(): void {
    const id = this.runningCompactionId
    if (!id) return
    this.runningCompactionId = null
    this.items.delete(id)
    this.order = this.order.filter((each) => each !== id)
    this.orderChanged = true
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
    this.finishStream()
    this.append({ kind: 'notice', id: this.mintId('n'), text, tone })
  }

  setPlanDecision(planId: string, decision: 'pending' | 'accepted' | 'rejected'): void {
    for (const [id, item] of this.items) {
      if (item.kind === 'plan' && item.planId === planId && item.decision !== decision) this.replace({ ...item, decision }, id)
    }
  }

  /** The answer to a worktree offer, from the host's activity or its reply. */
  setWorktreeOfferResolution(offerId: string, resolution: WorktreeOfferResolution): void {
    for (const [id, item] of this.items) {
      if (item.kind === 'worktree_offer' && item.offerId === offerId) this.replace({ ...item, resolution }, id)
    }
  }

  /** The open plan awaiting this session's decision, if any. */
  /** The setup card that runs now, newest first. */
  activeSetupCard(): StatusCardState | null {
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const item = this.items.get(this.order[index] ?? '')
      if (item?.kind === 'setup' && item.card.status === 'active') return item.card
    }
    return null
  }

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
    this.agentCards.closeTurn()
    this.finishStream()
    this.proseSinceUser = false
    this.lastResponseId = null
    if (event.clientPromptId) {
      this.queued = this.queued.filter((queued) => queued.clientPromptId !== event.clientPromptId)
      const existing = this.items.get(event.clientPromptId)
      if (existing?.kind === 'user') {
        if (existing.waitsForTurn) {
          this.order = [...this.order.filter(id => id !== existing.id), existing.id]
          this.orderChanged = true
          this.replace({ ...existing, sender: event.sender, via: event.via, text: splitAttachedFiles(event.text).text, waitsForTurn: false })
        } else if (event.sender || event.via) {
          this.replace({ ...existing, sender: event.sender, via: event.via })
        }
        this.markDelivery(event.clientPromptId, 'sent')
        return
      }
    }
    const backgroundCommand = event.via === 'background-command' ? backgroundCommandWake(event.text) : null
    if (backgroundCommand) {
      this.append({ kind: 'user', sender: event.sender, via: event.via, id: event.clientPromptId ?? this.mintId('u'), text: event.text, delivery: 'sent', error: null, attachments: [], backgroundCommand })
      return
    }
    const { text, files } = splitAttachedFiles(event.text, event.attachedFilePaths)
    const attachments = [...promptImageAttachments(event.imageAttachments, event.imageAttachmentRefs), ...files]
    this.append({ kind: 'user', sender: event.sender, via: event.via, id: event.clientPromptId ?? this.mintId('u'), text, delivery: 'sent', error: null, attachments })
  }

  private addPlanItem(id: string, plan: Omit<Extract<TranscriptItem, { kind: 'plan' }>, 'kind' | 'id' | 'planId'>, append: boolean): string {
    // A plan is named by its session, not by the provider thread (docs/plans/session-identity.md).
    const planId = planKey(this.sessionId, plan.planToolUseId)
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

  /** The offer's row id, or null when the row is already shown. */
  private addWorktreeOffer(activity: Extract<Activity, { kind: 'worktree_offered' }>, append: boolean): string | null {
    const id = `activity:${activity.id}`
    if (this.items.has(id)) return null
    const item: TranscriptItem = { kind: 'worktree_offer', id, offerId: activity.id, path: activity.path, branch: activity.branch ?? null, resolution: null }
    if (append) {
      this.finishStream()
      this.append(item)
    } else {
      this.items.set(id, item)
    }
    return id
  }

  /** Live dividers go before the prompt that caused them, as in saved history. */
  private addDivider(activity: AgentSwitch | Extract<Activity, { kind: 'forked' }>, live: boolean): string | null {
    const id = `activity:${activity.id}`
    if (this.items.has(id)) return null
    const item: TranscriptItem = activity.kind === 'forked'
      ? { kind: 'fork', id, activity }
      : { kind: 'handoff', id, activity }
    if (!live) {
      this.items.set(id, item)
      return id
    }
    this.finishStream()
    const lastId = this.order.at(-1)
    if (lastId === undefined || this.items.get(lastId)?.kind !== 'user') {
      this.append(item)
      return id
    }
    this.items.set(id, item)
    this.order = [...this.order.slice(0, -1), id, lastId]
    this.orderChanged = true
    return id
  }

  private resolveRequest(questionId: string, decision?: PermissionDecision): void {
    const before = this.permissions.length + this.questions.length
    this.permissions = this.permissions.filter((request) => request.questionId !== questionId)
    this.setQuestions(this.questions.filter((question) => question.questionId !== questionId))
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
    this.setQuestions(questions)
  }

  /** Stop ends every tool and sub-agent the turn started, and none sends a
   *  result after it (the desktop reducer's `settleInterruptedTools`). */
  private settleInterruptedTools(): void {
    for (const [id, item] of this.items) {
      if (item.kind !== 'tool' || item.status !== 'running') continue
      this.replace(item.subagent ? { ...item, status: 'error', report: item.report ?? 'Interrupted' } : { ...item, status: 'error' }, id)
    }
  }

  private clearRequests(): void {
    if (this.permissions.length === 0 && this.questions.every((question) => question.responseMode === 'message')) return
    this.permissions = []
    // A message-mode question is answered by a later prompt, so it outlives the turn.
    this.setQuestions(this.questions.filter((question) => question.responseMode === 'message'))
    this.metaChanged = true
  }

  private patchToolById(toolId: string, runningOnly: boolean, patch: (tool: Extract<TranscriptItem, { kind: 'tool' }>) => Extract<TranscriptItem, { kind: 'tool' }>): void {
    const id = this.toolRows.find(this, toolId, runningOnly)
    const item = id ? this.items.get(id) : undefined
    if (!id || item?.kind !== 'tool') return
    const next = patch(item)
    const body = savedTurnItems.get(item)
    if (body && next.input === item.input && next.toolName === item.toolName) savedTurnItems.set(next, body)
    this.replace(next, id)
    // A failed orchestration call made no card: it shows after all.
    if (next.status === 'error' && this.heldTools.delete(id)) {
      if (this.collecting) this.collecting.push(id)
      else {
        this.order = [...this.order, id]
        this.orderChanged = true
      }
    }
  }

  /** Setup ends when the session leaves `connecting`: no stage stays active. */
  private settleSetupCards(status: SessionStatus): void {
    for (const [id, item] of this.items) {
      if (item.kind !== 'setup' || item.card.status !== 'active') continue
      this.replace({ ...item, card: settleSetupCard(item.card, status) }, id)
    }
  }

  /** A provider subagent's rows go to its own transcript on the call that
   *  started it, never into the parent feed. */
  private childTranscript(toolId: string, apply: (child: TranscriptModel) => void): void {
    this.patchToolById(toolId, false, (tool) => {
      const children = tool.children ?? new TranscriptModel(`${this.sessionId}:${toolId}`)
      apply(children)
      return { ...tool, children, childCount: children.order.length }
    })
  }

  /** A live activity of a kind the feed shows. */
  private applyActivity(activity: Activity): void {
    if (activity.kind === 'mcp_app') this.addMcpApp(activity, true)
    else if (activity.kind === 'worktree_offered') this.addWorktreeOffer(activity, true)
    else if (activity.kind === 'worktree_offer_decided') this.setWorktreeOfferResolution(activity.offerId, activity.resolution)
    else if (activity.kind === 'agent_switched' || activity.kind === 'forked') this.addDivider(activity, true)
    else if (activity.kind === 'stopped') this.addSessionEvent(activity, true)
  }

  /** Stops stay visible on every client, including the one that sent Stop. */
  private addSessionEvent(activity: Activity, append: boolean): string | null {
    if (activity.kind !== 'stopped') return null
    const id = `activity:${activity.id}`
    if (this.items.has(id)) return null
    const text = activity.by.kind === 'agent'
      ? `Stopped by ${activity.by.title ?? 'an agent'}`
      : activity.by.kind === 'user' ? `Stopped by ${activity.by.user.displayName}` : 'Stopped'
    const item: TranscriptItem = { kind: 'notice', id, text, tone: 'info' }
    if (append) {
      this.finishStream()
      this.append(item)
    } else {
      this.items.set(id, item)
    }
    return id
  }

  private addMcpApp(activity: Extract<Activity, { kind: 'mcp_app' }>, append: boolean): string | null {
    const id = `activity:${activity.id}`
    if (this.items.has(id)) return null
    const item: TranscriptItem = { kind: 'mcp_app', id, activityId: activity.id, sessionId: activity.subject.id, app: activity.app }
    if (append) {
      this.finishStream()
      this.append(item)
    } else {
      this.items.set(id, item)
    }
    return id
  }

  private append(item: TranscriptItem): void {
    // Live messages arrive without a stored time. Keep their arrival time through later text updates.
    if ((item.kind === 'user' || item.kind === 'assistant' || item.kind === 'tool') && item.timestamp === undefined) item.timestamp = Date.now()
    this.items.set(item.id, item)
    this.trackAgent(item)
    this.indexAgentTurn(item)
    this.order = [...this.order, item.id]
    this.orderChanged = true
  }

  private replace(item: TranscriptItem, id = item.id): void {
    this.items.set(id, item)
    this.trackAgent(item)
    this.changedItems.add(id)
  }

  private mintId(prefix: string): string {
    this.nextId += 1
    return `${prefix}${this.nextId}`
  }
}

function pendingQuestion(event: Extract<WireNormalizedEvent, { type: 'question_request' }>): PendingQuestion {
  const { type, turnAuthor, ...question } = event
  return question
}

/** Output of a turn the user stopped; the host may still flush some of it. */
const DROPPED_WHILE_INTERRUPTED = new Set<WireNormalizedEvent['type']>([
  'text_chunk', 'assistant_message', 'thinking', 'tool_call', 'tool_call_update', 'tool_call_complete', 'tool_progress', 'plan',
])

/** Provider subagent calls the host names without the live flag (history, older hosts),
 *  as the desktop transcript reads them. */
function subagentFromToolName(toolName: string): string | null {
  if (toolName === 'Task' || toolName === 'Agent') return 'claude'
  if (toolName === 'mcp__solus__codex_subagent') return 'codex'
  if (toolName.slice(toolName.lastIndexOf('.') + 1) === 'claude_subagent') return 'claude'
  return null
}
