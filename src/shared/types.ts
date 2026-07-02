import rawModelProfiles from './model-profiles.json'
import type { GitProjectStatus } from './git-types'

// ─── Agent ID (needed by ModelProfile below) ───

export type AgentId = 'claude-code' | 'codex' | 'opencode'

export const AGENT_BIN: Record<AgentId, string> = {
  'claude-code': 'claude',
  'codex': 'codex',
  'opencode': 'opencode',
}

// ─── Shared primitive types used by NormalizedEvent and multiple layers ───

export interface ContentBlock {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

export type ContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }

export interface AssistantMessagePayload {
  model: string
  id: string
  role: 'assistant'
  content: ContentBlock[]
  stop_reason: string | null
  usage: UsageData
}

export interface UsageData {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  reasoning_output_tokens?: number
}

/** A selectable response for a permission or plan prompt (main→renderer form). */
export interface PermissionOption {
  id: string
  label: string
  kind?: string
}

// ─── Model Configuration ───

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode'

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultracode: 'Ultra Code'
}

export interface ModelConfig {
  modelId: string | null
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
  fastMode: boolean
}

// ─── Model Profiles ───

export interface ModelProfile {
  label: string
  isDefault?: boolean
  reasoningLevels: ReasoningEffort[]
  defaultReasoningEffort: ReasoningEffort
  supportsFastMode: boolean
  contextWindows: number[]
  defaultContextWindow: number
}

export const MODEL_PROFILES = rawModelProfiles as Partial<Record<AgentId, Record<string, ModelProfile>>>

// ─── Session Status ───

export type SessionStatus =
  | 'connecting'
  | 'idle'
  | 'running'
  | 'awaiting_input'
  | 'awaiting_plan'
  | 'rate_limited'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'dead'

export interface PermissionRequest {
  questionId: string
  toolTitle: string
  toolDescription?: string
  toolInput?: Record<string, unknown>
  options: Array<{ optionId: string; kind?: string; label: string }>
}

export interface QuestionOption {
  label: string
  description?: string
  preview?: string
}

export interface QuestionItem {
  id?: string
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface QuestionRequest {
  questionId: string
  questions: QuestionItem[]
  kind?: 'standard' | 'mcp_form' | 'mcp_url'
  message?: string
  url?: string
  serverName?: string
  canDecline?: boolean
  canCancel?: boolean
}

export interface Attachment {
  id: string
  type: 'image' | 'file' | 'design-selection'
  name: string
  path: string
  mimeType?: string
  /** Base64 data URL for image previews */
  dataUrl?: string
  /** File size in bytes */
  size?: number
  /** Rich metadata for design mode selections */
  designData?: DesignModeSelection
}

export interface DesignAnnotation {
  id: string
  type: 'rectangle' | 'arrow' | 'pin' | 'text'
  /** Coordinates relative to the screenshot (0-1 normalized) */
  x: number
  y: number
  width?: number
  height?: number
  /** End point for arrows (normalized) */
  endX?: number
  endY?: number
  /** Marker number for pins, or text content for text annotations */
  label?: string
}

export interface DesignModeSelection {
  /** Cropped element screenshot as data URL */
  screenshot: string
  /** Element's outer HTML (truncated if large) */
  outerHTML?: string
  /** Unique CSS selector path */
  cssSelector?: string
  /** Key computed CSS properties */
  computedStyles?: Record<string, string>
  /** Framework component name (React/Svelte/Vue) */
  componentName?: string
  /** Source file path from source maps */
  componentFile?: string
  /** Page URL where element was selected */
  pageURL?: string
  /** Viewport dimensions */
  viewport?: { width: number; height: number }
  /** User-drawn annotations */
  annotations?: DesignAnnotation[]
}

/** The composer state for one tab (or the tab-less active input). */
export interface InputState {
  text: string
  /** Images are attachments with type: 'image'. */
  attachments: Attachment[]
  planRefs: PlanReference[]
  workRefs: WorkReference[]
}

/** UI-only state. One per open tab in the renderer. */
export interface Tab {
  id: string
  sessionId: string
  title: string
  hasUnread: boolean
  input: InputState
  diffComments: DiffComment[]
  diffGeneralComment: string
  diffCommentDraft: DiffCommentDraft | null
}

/** Backend-driven session state. Shared across tabs watching the same session. */
export interface Session {
  id: string
  agentSessionId: string | null
  provider: AgentId | null
  status: SessionStatus
  messages: Message[]
  currentActivity: string
  isStreamingText: boolean
  isReconnecting: boolean
  permissionQueue: PermissionRequest[]
  questionQueue: QuestionRequest[]
  permissionDenied: { tools: Array<{ toolName: string; toolUseId: string }> } | null
  serverQueuedPrompts: QueuedPromptSnapshot[]
  rateLimitInfo: RateLimitInfo | null
  rateLimitStrategy: 'queue' | 'ask' | 'stop' | 'continue'
  lastResult: RunResult | null
  /** Cumulative token usage for the completed run (from task_complete). Drives the breakdown rows in the context meter. */
  sessionUsage: UsageData | null
  latestCheckpointId: string | null
  sessionModel: string | null
  sessionTools: string[]
  sessionMcpServers: Array<{ name: string; status: string }>
  sessionSkills: string[]
  sessionVersion: string | null
  pluginCommands: PluginCommandsResult
  progress: SessionProgress | null
  changedFiles: string[]
  gitContext: TabGitContext | null
  workingDirectory: string
  additionalDirs: string[]
  modelConfig: ModelConfig
  permissionMode: 'ask' | 'auto' | 'plan'
  worktreeBaseBranch: string | null
  readOnlyReason: string | null
  loadingHistory: boolean
  /** True when only a recent window of the transcript was hydrated and older
   *  messages still live on disk (fetched on demand via expandHistory). */
  historyTruncated: boolean
  /** Agent session ID this session was forked from. */
  forkedFromSessionId: string | null
  /** True until the first prompt is sent, so the provider starts from a fork of agentSessionId. */
  forked: boolean
  /** Work this session is actively collaborating on. Its current content is
   *  injected into each prompt so the agent revises the live version. */
  boundWorkId: string | null
  /** Task (ticket) this session was started from. The hydrated ticket is injected
   *  at session start so the agent already knows it; drives the "working on #123"
   *  chip and back-link. Mirror of boundWorkId. */
  boundTaskId: string | null
  /** Set when this session is the chat tab of a PR review (worktree = PR head).
   *  Drives the PR-context system hint and the `'pr'` diff scope. */
  prReview: PrReviewContext | null
}

export interface PinnedSessionManifest {
  sessions: Record<string, PinnedSession>
}

export interface PinnedSession {
  /** Agent session id — the key used to dedupe and resume. */
  sessionId: string
  provider: AgentId
  title: string
  /** Real working directory; the backend re-encodes this to locate the transcript. */
  cwd: string
  /** Epoch ms when the session was pinned; drives ordering. */
  pinnedAt: number
}

export interface DiffCommentDraft {
  filePath: string
  startLine: number
  endLine: number
  side: 'old' | 'new'
  /** If set, the draft is editing an existing comment instead of creating a new one */
  editingCommentId: string | null
  value: string
}

export interface TodoItem {
  content: string
  status: 'completed' | 'in_progress' | 'pending'
}

export interface SessionProgress {
  todos: TodoItem[]
  currentStep: number
  totalSteps: number
}

export interface PlanComment {
  id: string
  selectedText: string
  comment: string
  textOffset?: number
}

export interface DiffComment {
  id: string
  filePath: string
  startLine: number
  endLine: number
  side: 'old' | 'new'
  selectedCode: string
  comment: string
  /** Epoch ms when the comment was first created. */
  createdAt: number
}

/**
 * Per-session context for reviewing an incoming GitHub PR. Carried on the tab
 * alongside `diffComments`. The worktree is the PR head checked out locally, so
 * the agent's reads see the real post-change files.
 */
export interface PrReviewContext {
  /** e.g. `github.com`. */
  host: string
  /** Owner of the base repo (where the PR lives). */
  owner: string
  /** Base repo name (where the PR lives). */
  repo: string
  number: number
  /** PR title — surfaced in the review header and the agent system hint. */
  title: string
  /** PR base branch (e.g. `main`) — the worktree's target branch + companion target. */
  baseRef: string
  /** PR head commit at load/refresh — the anchor for new review comments. */
  headSha: string
  /** `merge-base(base, head)` — diff base + companion episode base. */
  baseSha: string
  /** Where the head branch lives; `isFork` true when it differs from the base repo. */
  headRepo: { owner: string; repo: string; isFork: boolean }
  /** `.solus-worktrees/pr-<n>`. */
  worktreePath: string
  /** Local review branch, e.g. `solus/pr-<n>`. */
  branch: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system' | 'plan'
  content: string
  toolName?: string
  toolId?: string
  toolIndex?: number
  toolInput?: string
  toolStatus?: 'running' | 'completed' | 'error'
  /** The tool's `tool_result` content (e.g. a sub-agent's final answer to the
   *  main agent). Drives the sub-agent card's done/error state and summary. */
  toolResult?: string
  toolResultIsError?: boolean
  /** Nested transcript for a sub-agent (Agent/Task) tool call: every child event
   *  (tool calls + assistant text) diverted out of the main thread by
   *  `parentToolUseId`. Presence === "render this tool as a sub-agent card." */
  subMessages?: Message[]
  /** Live streaming text buffer for the sub-agent's current assistant block. */
  subStreamText?: string
  /** Resolved `subagent_type` from the Agent tool input, for the card's chip. */
  subagentType?: string
  timestamp: number
  /** Reference to Plan entity in PlanStore */
  planId?: string
  /** Stable ExitPlanMode tool_use id — used for scroll-to-plan targeting */
  planToolUseId?: string
  /** Reference to a Work (folio document) */
  workRef?: { workId: string; title: string; workType?: 'doc' | 'slides' | 'diagram' }
  /** A rendered visual artifact (render_artifact tool) shown flush in the
   *  conversation. `pending` is true while the tool call is still in flight. */
  artifact?: { kind: 'html' | 'image'; html?: string; path?: string; pending?: boolean }
  /** Reference to an automation the agent created or updated in this thread,
   *  rendered as a card with an Open action. */
  automationRef?: { automationId: string; name: string; trigger: AutomationTrigger; enabled: boolean }
  /** Reference to a session the agent spawned via create_session, rendered as a
   *  card that opens the new session in a tab. Live-only (not persisted to the
   *  transcript), so it's lost on a history reload. */
  sessionRef?: { agentSessionId: string; title: string; provider: AgentId; cwd: string }
  /** Attachments submitted with this user message (name + preview dataUrl) */
  attachments?: Array<{ name: string; dataUrl?: string; mimeType?: string; type?: 'image' | 'file' | 'design-selection' }>
  /** Plan references attached via # autocomplete */
  planRefs?: PlanReference[]
  /** Work references attached via the work reference picker */
  workRefs?: WorkReference[]
  /** Set on the fork-divider system message to identify it. */
  forkSourceSessionId?: string
  /** Snapshot of the source session title at fork time. */
  forkSourceTitle?: string
  /** Set on the divider system message when a session is moved into a worktree;
   *  holds the new worktree branch name. */
  worktreeMovedTo?: string
  /** Set on a user message that an automation injected into this thread, so the
   *  bubble can render a "Sent via automation" badge. Live-only (not persisted to
   *  the transcript), so it's lost on a history reload. */
  via?: 'automation'
  automationId?: string
  automationName?: string
}

// ─── Folio / Works ───

export type WorkStorage =
  | { kind: 'local' }
  | { kind: 'project'; projectRoot?: string; relativePath: string }

export interface WorkMeta {
  title: string
  preview: string
  type: 'doc' | 'slides' | 'diagram'
  createdAt: string
  updatedAt: string
  /** Origin session (kept for back-compat). Prefer `sessionIds` for resume. */
  sessionId?: string
  /** Every session that has collaborated on this work, oldest→newest. */
  sessionIds?: string[]
  agentProvider: AgentId
  cwd: string
  /** Where this work is persisted. Missing means legacy local storage. */
  storage?: WorkStorage
  /** Pinned works sort to the top of the gallery. */
  pinned?: boolean
}

export interface WorksManifest {
  version: number
  works: Record<string, WorkMeta>
}

export interface Work extends WorkMeta {
  id: string
  content: string
}

export interface WorkReference {
  workId: string
  title: string
  type: 'doc' | 'slides' | 'diagram'
}

// ─── Plans ───

export interface PlanMessageRef {
  kind: 'plan' | 'document';
  id?: string;
  title?: string;
  content?: string;
  /** Only set when kind === 'document' — distinguishes diagram from doc/slides */
  workType?: 'doc' | 'slides' | 'diagram';
  /** True while a create_work tool call is still streaming content into the card. */
  streaming?: boolean;
  comments?: PlanComment[];
  status?: 'pending' | 'accepted' | 'rejected';
  bookmarked?: boolean;
}

export interface Plan {
  id: string
  sessionId: string
  planToolUseId: string
  projectPath: string
  cwd: string
  timestamp: number
  content: string
  filePath?: string
  questionId?: string
  options?: PermissionOption[]
  title: string
  status: 'pending' | 'accepted' | 'rejected'
  comments: PlanComment[]
  bookmarked: boolean
  bookmarkedAt?: number
}

export interface PlanReference {
  planId: string
  sessionId: string
  planToolUseId: string
  title: string
  status: 'pending' | 'accepted' | 'rejected'
}

export function planKey(sessionId: string, planToolUseId: string): string {
  return `${sessionId}__${planToolUseId}`
}

// ─── Plans Gallery ───

export interface PlanAnnotations {
  version: 1
  sessionId: string
  projectPath: string
  cwd: string
  planToolUseId: string
  title: string
  status: 'pending' | 'accepted' | 'rejected'
  comments: PlanComment[]
  bookmarked: boolean
  bookmarkedAt?: number
  updatedAt: number
}

/** Selection comments on a work (document), stored in a per-work sidecar. */
export interface WorkAnnotations {
  version: 1
  workId: string
  comments: PlanComment[]
  updatedAt: number
}

/** Single previous version of a work, snapshotted on agent-driven saves. */
export interface WorkPrevious {
  content: string
  updatedAt: string
}

export interface PlanRevisionSummary {
  planToolUseId: string
  timestamp: number
  title: string
  excerpt: string
  status: 'pending' | 'accepted' | 'rejected'
  commentCount: number
  planFilePath?: string
}

export interface PlanDescriptor {
  provider?: AgentId
  planToolUseId: string
  sessionId: string
  projectPath: string
  cwd: string
  timestamp: number
  title: string
  excerpt: string
  status: 'pending' | 'accepted' | 'rejected'
  commentCount: number
  bookmarked: boolean
  bookmarkedAt?: number
  planFilePath?: string
  revisions: PlanRevisionSummary[]
}

export type SessionScanEvent =
  | { streamId: string; type: 'batch'; sessions: SessionMeta[] }
  | { streamId: string; type: 'done'; totalSessions: number }

export interface RunResult {
  totalCostUsd: number
  durationMs: number
  numTurns: number
  usage: UsageData
  sessionId: string
}

// ─── Canonical Events (normalized from raw stream) ───

export type NormalizedEvent =
  | { type: 'session_init'; sessionId: string; tools: string[]; model: string; mcpServers: Array<{ name: string; status: string }>; skills: string[]; version: string }
  | { type: 'text_chunk'; text: string; parentToolUseId?: string }
  | { type: 'tool_call'; toolName: string; toolId: string; index: number; toolInput?: string; content?: string; parentToolUseId?: string }
  | { type: 'tool_call_update'; toolId: string; index?: number; toolInput?: string; toolInputDelta?: boolean; content?: string; parentToolUseId?: string }
  | { type: 'tool_call_complete'; index: number; toolId?: string; parentToolUseId?: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; parentToolUseId?: string }
  | { type: 'task_update'; message: AssistantMessagePayload; parentToolUseId?: string }
  | { type: 'task_complete'; result: string; costUsd: number; durationMs: number; numTurns: number; usage: UsageData; sessionId: string; permissionDenials?: Array<{ toolName: string; toolUseId: string }> }
  | { type: 'background_task_started'; taskId: string }
  | { type: 'background_task_settled'; taskId: string; status: 'completed' | 'failed' | 'stopped' | 'killed' }
  | { type: 'error'; message: string; isError: boolean; sessionId?: string }
  | { type: 'session_dead'; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'rate_limit'; status: string; resetsAt: number; rateLimitType: string; isUsingOverage?: boolean; usedPercent?: number; windowDurationMins?: number; info?: RateLimitInfo; message?: string }
  | { type: 'usage'; usage: UsageData; sessionUsage?: UsageData }
  | { type: 'permission_request'; questionId: string; toolName: string; toolDescription?: string; toolInput?: Record<string, unknown>; options: PermissionOption[] }
  | { type: 'permission_resolved'; questionId: string }
  | { type: 'question_request'; questionId: string; questions: QuestionItem[] }
  | { type: 'pending_input_sync'; pendingInputEvents: NormalizedEvent[] }
  | { type: 'plan'; planContent: string; planFilePath: string; questionId: string; options: PermissionOption[]; planToolUseId?: string }
  | { type: 'progress'; todos: TodoItem[] }
  | { type: 'checkpoint'; checkpointId: string }
  | { type: 'git_context'; gitContext: TabGitContext }
  | { type: 'git_status'; cwd: string; status: GitProjectStatus | null }
  | { type: 'user_message'; text: string; imageAttachments?: Array<{ mimeType: string; dataUrl: string }>; via?: 'automation'; automationId?: string; automationName?: string }
  | { type: 'prompt_queued'; text: string; queueId: string; enqueuedAt: number; reason?: QueuedPromptReason; releaseAt?: number; rateLimitType?: string; images?: Array<{ mimeType: string; dataUrl: string }> }
  | { type: 'prompt_dequeued'; queueId: string }
  | { type: 'rate_limit_resolved'; sessionId: string; action: RateLimitDecisionAction }
  | { type: 'goal_updated'; goal: ThreadGoal }
  | { type: 'goal_cleared'; threadId: string }
  | { type: 'status_change'; status: SessionStatus; oldStatus: SessionStatus }
  | { type: 'plan_rejected'; planToolUseId: string }
  | { type: 'permission_mode_changed'; permissionMode: 'ask' | 'auto' | 'plan' }
  | { type: 'work_created'; workId: string; title: string; docType: 'doc' | 'slides' | 'diagram'; content: string }
  | { type: 'work_updated'; workId: string; title: string; docType: 'doc' | 'slides' | 'diagram'; content: string; updatedAt: string }
  | { type: 'artifact_created'; kind: 'html' | 'image'; html?: string; path?: string }
  | { type: 'automation_saved'; automationId: string; name: string; trigger: AutomationTrigger; enabled: boolean }
  | { type: 'session_created'; agentSessionId: string; title: string; provider: AgentId; cwd: string }

// ─── Prompt Options ───

export interface PromptOptions {
  prompt: string
  /** User-visible prompt text. `prompt` may include internal attachment/reference context. */
  displayPrompt?: string
  /** Image attachments sent as real content blocks rather than flattened into `prompt`.
   *  `dataUrl` is a base64 data URL (`data:<mime>;base64,<data>`). */
  imageAttachments?: Array<{ mimeType: string; dataUrl: string }>
  /** Set when a session is started from a task. On the first dispatch the main
   *  process hydrates the ticket and prepends its context to `prompt`, so the
   *  agent starts already knowing it. Only meaningful on session start. */
  taskId?: string
  systemPrompt?: string
  maxTurns?: number
  maxBudgetUsd?: number
  /** Path to SOLUS-scoped settings file with hook config (passed via --settings) */
  hookSettingsPath?: string
  /** Marks the prompt as injected by an automation firing in-thread, so the UI
   *  can badge the user message ("Sent via automation"). */
  via?: 'automation'
  /** Source automation id/name, present when `via === 'automation'`. */
  automationId?: string
  automationName?: string
}

// ─── IPC Context ───

export interface SessionCtx {
  tabId: string
  provider: AgentId | null
  agentSessionId: string | null
  status: SessionStatus
  workingDirectory: string
  projectPath: string
  additionalDirs: string[]
  preferredModel: string | null
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
  fastMode: boolean
  permissionMode: 'ask' | 'auto' | 'plan'
  gitContext: TabGitContext | null
  worktreeBaseBranch: string | null
  changedFiles: string[]
  readOnlyReason: string | null
  latestCheckpointId: string | null
  title?: string | null
  forked?: boolean
  /** PR review context for this session's chat tab (null for normal sessions). */
  prReview?: PrReviewContext | null
}

export interface WindowCtx {
  viewMode: 'pill' | 'editor'
}

export type AppFontFamily = 'inter' | 'dm-sans' | 'system' | 'geist' | 'lora' | 'sf-pro-text' | 'sf-mono'
export type AppCodeFontFamily = 'sf-mono' | 'geist-mono' | 'fira-code' | 'cascadia-code' | 'jetbrains-mono' | 'system-mono'

export interface SettingsCtx {
  themeMode: 'dark' | 'light' | 'system'
  isDark: boolean
  soundEnabled: boolean
  voiceModeEnabled: boolean
  vadSilenceMs: number
  defaultEditor: EditorId | null
  defaultTerminal: TerminalAppId | null
  activeAgent: AgentId
  worktreeEnabled: boolean
  rateLimitBehavior: 'ask' | 'queue' | 'continue' | 'stop'
  fontFamily: AppFontFamily
  fontSize: number
  codeFontFamily: AppCodeFontFamily
  codeFontSize: number
  /** App-wide instructions appended to every agent system prompt. */
  extraInstructions: string
}

export interface StatusBarCtx {
  workingDirectory: string
  activeAgent: AgentId
  permissionMode: 'ask' | 'auto' | 'plan'
  model: string
  reasoningEffort: ReasoningEffort
  defaultReasoningEffort: ReasoningEffort
  reasoningLevels: ReasoningEffort[]
  supportsFastMode: boolean
  fastMode: boolean
  contextWindows: number[]
}

export interface IpcContext {
  session: SessionCtx
  window: WindowCtx
  settings: SettingsCtx
  statusBar: StatusBarCtx
}

/**
 * The minimal, caller-agnostic contract for running a turn against a session —
 * what the dispatch path and backends actually consume, with none of the UI
 * presentation state in IpcContext. Any system (the renderer, automations, a
 * future HTTP/MCP caller) can build this plain object directly to start, resume,
 * or send a message, instead of fabricating a full IpcContext snapshot.
 *
 * `agentSessionId` is the primary key: null starts a new session, a value
 * resumes that session (the backend loads it from disk if it isn't resident, so
 * a caller can cold-start a session it never opened in the UI). `tabId` is an
 * optional UI subscription hint — absent for headless/automation runs.
 */
export interface SessionRunInput {
  /** Present for UI-driven runs; absent for headless/automation runs. */
  tabId?: string
  /** Resolved backend provider (no null — the caller picks before dispatch). */
  provider: AgentId
  /** null = start a new session; set = resume this session. */
  agentSessionId: string | null
  forked: boolean
  workingDirectory: string
  projectPath: string
  additionalDirs: string[]
  gitContext: TabGitContext | null
  worktreeBaseBranch: string | null
  changedFiles: string[]
  contextWindow: number | null
  /** Resolved model the run uses (the value the backend actually runs with). */
  model: string
  /** The user's explicit model choice (null = "use default"); surfaced back to a
   *  reattaching client via bindRuntimeSession. Distinct from the resolved `model`. */
  preferredModel: string | null
  reasoningEffort: ReasoningEffort
  fastMode: boolean
  permissionMode: 'ask' | 'auto' | 'plan'
  rateLimitBehavior: SettingsCtx['rateLimitBehavior']
  /** App-wide instructions appended to every agent system prompt. */
  extraInstructions: string
  /** PR review context — when set, the backend appends a PR-context system hint. */
  prReview?: PrReviewContext | null
}

// ─── Control Plane Types ───

export interface BackendSession {
  sessionId: string
  backendId: AgentId
  status: SessionStatus
  hasPendingInput?: boolean
  pendingInputEvents: NormalizedEvent[]
  /** The resolved run contract this session last ran with — the single source of
   *  truth for the session's config. Read by bindRuntimeSession to rehydrate a
   *  reattaching client, and by background triggers (e.g. an in-thread automation)
   *  to re-dispatch into the session with no UI snapshot to reconstruct. */
  runInput?: SessionRunInput
  gitContext?: TabGitContext
  lastActivityAt: number
  promptCount: number
  /** Task IDs of run_in_background sub-agents/tools still in flight. While this is
   *  non-empty the session is kept 'running' past turn end — the SDK query stays
   *  open servicing the background work and will only truly exit once it settles. */
  backgroundTaskIds?: Set<string>
}

export interface RuntimeSessionInfo {
  modelConfig: ModelConfig
  permissionMode: 'ask' | 'auto' | 'plan'
  status: SessionStatus
  queuedPrompts: QueuedPromptSnapshot[]
  rateLimitInfo: RateLimitInfo | null
}

export type QueuedPromptReason = 'busy' | 'rate_limit'

/** Thin subscription record — the tab exists and may watch a session. */
export interface TabRegistryEntry {
  tabId: string
  /** Points into the activeSessions map (= agent session ID). Null until session_init fires. */
  sessionId: string | null
  createdAt: number
  /** Per-tab display status. Mirrors session status after session_init; tracks 'connecting' before. */
  status: SessionStatus
  /** Updated on every event from this tab's backend run. */
  lastActivityAt: number
}

export interface QueuedPromptSnapshot {
  queueId: string
  text: string
  enqueuedAt: number
  reason: QueuedPromptReason
  releaseAt?: number
  rateLimitType?: string
  /** Image attachments sent with the queued prompt, so the queued bubble can
   *  render them. `dataUrl` is a base64 data URL (`data:<mime>;base64,<data>`). */
  images?: Array<{ mimeType: string; dataUrl: string }>
}

export interface RateLimitInfo {
  resetsAt: number
  rateLimitType: string
  prompt: string
  queuedPrompt: string
}

export type RateLimitDecisionAction = 'send_now' | 'stop' | 'wait'

export type ThreadGoalStatus = 'active' | 'complete' | 'blocked' | 'budgetLimited' | 'usageLimited'

export interface ThreadGoal {
  threadId: string
  objective: string
  status: ThreadGoalStatus
  tokenBudget?: number
  tokensUsed?: number
  timeUsedSeconds?: number
  createdAt?: number
  updatedAt?: number
}

export interface ThreadGoalSetRequest {
  threadId: string
  objective?: string
  status?: ThreadGoalStatus
  tokenBudget?: number
}

export interface EnrichedError {
  message: string
  stderrTail: string[]
  stdoutTail?: string[]
  exitCode: number | null
  elapsedMs: number
  toolCallCount: number
  sawPermissionRequest?: boolean
  permissionDenials?: Array<{ tool_name: string; tool_use_id: string }>
}

// ─── Session History ───

export interface SessionMeta {
  provider: AgentId
  sessionId: string
  slug: string | null
  firstMessage: string | null
  lastTimestamp: string
  size: number
  cwd: string         // actual working directory read from the JSONL cwd field
  projectPath: string // raw encoded folder name, e.g. "-Users-sidhu-clui-cc"
  isWorktree?: boolean
  status?: SessionStatus
}

export interface RecentProject {
  path: string          // decoded real path, e.g. "/Users/example/projects/solus"
  folderName: string    // last segment, e.g. "solus"
  lastOpened: string    // ISO timestamp of last open
}

// Every project Solus has seen, persisted in ~/.solus/projects/manifest.json.
export interface ProjectEntry {
  key: string           // hash of the repo root / cwd; names the ~/.solus/projects/<key> dir
  path: string          // decoded real path
  folderName: string    // last path segment
  addedAt: string       // ISO timestamp first recorded
}

// ─── Agent Types ───

export interface AgentMetadata {
  id: AgentId
  label: string
  models: Array<{ id: string; label: string }>
  defaultModel: string
  available?: boolean
  unavailableReason?: string
  binaryPath?: string
  capabilities?: {
    planMode?: boolean
    permissions?: boolean
    fileRewind?: boolean
    terminalResume?: boolean
    transport?: string
  }
}

export interface StartInfo {
  version: string
  auth?: { email?: string; subscriptionType?: string; authMethod?: string }
  mcpServers?: string[]
  projectPath: string
  homePath: string
  workspacePath: string
  agents: AgentMetadata[]
}

// ─── Editor / Terminal Types ───

export type EditorId = 'vscode' | 'vim' | 'nvim' | 'helix'
export type TerminalAppId = 'default-terminal' | 'ghostty'

export interface DetectedEditor {
  id: EditorId
  name: string
  isTerminal: boolean
  binPath: string
}

export interface DetectedTerminal {
  id: TerminalAppId
  name: string
}

export interface TerminalLaunchRequest {
  command: string
  terminalId: TerminalAppId
  cwd?: string
}

export interface OpenInEditorRequest {
  filePaths: string[]
  editorId: EditorId
  terminalId?: TerminalAppId
  cwd?: string
}

export interface FilePreviewRequest {
  path: string
  cwd?: string
}

export interface ProjectFilesRequest {
  cwd?: string
}

export type ProjectFilesResult =
  | {
      ok: true
      root: string
      files: string[]
      truncated: boolean
      source: 'index'
    }
  | {
      ok: false
      root?: string
      error: string
    }

export interface WriteFileRequest {
  path: string
  contents: string
  cwd?: string
  expectedContents?: string
}

export type WriteFileResult =
  | {
      ok: true
      path: string
      displayPath: string
      size: number
    }
  | {
      ok: false
      path: string
      error: string
      conflict?: boolean
    }

/** A file-autocomplete result row, fully resolved by the backend. */
/**
 * A platform-agnostic key combo, structurally identical to the renderer's
 * keybindings `KeyCombo`. Used by the OS summon-shortcut RPCs so the main
 * process doesn't import renderer code. `mod` = Command on macOS, Control else.
 */
export interface AppShortcutCombo {
  code: string
  alt?: boolean
  shift?: boolean
  meta?: boolean
  ctrl?: boolean
  mod?: boolean
}

/** The two OS-level "summon Solus" shortcuts (desktop-only). */
export interface AppGlobalShortcuts {
  primary: AppShortcutCombo
  secondary: AppShortcutCombo
}

/** Accelerators that couldn't be live-registered (caller offers a restart). */
export interface SetAppGlobalShortcutsResult {
  failed: string[]
}

export interface FileMatch {
  /** Absolute path, no trailing slash. */
  path: string
  /** What the menu renders: cwd-relative inside the project, absolute outside. */
  display: string
  isDir: boolean
}

export type FilePreviewResult =
  | {
      ok: true
      path: string
      displayPath: string
      contents: string
      size: number
      mimeType?: string
    }
  | {
      ok: false
      path: string
      error: string
    }

// ─── Plugin Commands ───

export interface PluginCommand {
  name: string
  description: string
  argumentHint?: string
  kind?: 'command' | 'skill'
  path?: string
}

/** A slash command reported by the agent's SDK init (built-ins, custom, skills). */
export interface AgentSlashCommand {
  name: string
  description: string
  argumentHint?: string
  aliases?: string[]
}

export interface PluginCommandsResult {
  global: PluginCommand[]
  project: PluginCommand[]
  /** Built-in agent commands reported live by the SDK (claude-code only). */
  builtin?: AgentSlashCommand[]
}

// ─── IPC Payloads ───

export type SkillState = 'pending' | 'downloading' | 'validating' | 'installed' | 'failed' | 'skipped'

/** Emitted on `solus:skill-status` to report skill install progress. */
export interface SkillStatus {
  name: string
  state: SkillState
  error?: string
  reason?: 'up-to-date' | 'user-managed'
}

// ─── skills.sh registry (opt-in install) ───

/** A skill returned by the skills.sh registry search API. */
export interface RemoteSkill {
  /** The `owner/repo@skill` install target passed verbatim to `skills add`. */
  id: string
  /** Display name — the skill segment after `@`, or the repo's last path part. */
  name: string
  /** `owner/repo` the skill lives in. */
  repo: string
  /** Raw install-count label from the registry (e.g. "444.8K"); undefined if unknown. */
  installs?: string
  /** Canonical skills.sh page for the skill. */
  url: string
}

/** Result of installing a skill across the active providers. */
export interface SkillInstallResult {
  ok: boolean
  /** Providers the skill was installed into (the active backends at install time). */
  agents: AgentId[]
  error?: string
}

// ─── Git Context Types ───

export const SOLUS_WORKTREE_DIR = '.solus-worktrees'
export const SOLUS_WORKTREE_PATH_MARKER = `/${SOLUS_WORKTREE_DIR}/`

/**
 * Encode a filesystem path the way Claude Code names its on-disk project folders
 * (`~/.claude/projects/<encoded>/`): every non-alphanumeric character becomes
 * `-`, not just slashes. Paths containing dots — notably worktrees under
 * `.solus-worktrees` — must use this or the folder won't resolve and the
 * session `.jsonl` / plan files come back empty. Codex uses it only as an
 * internal grouping key, so consistency is all that matters there.
 */
export function encodePathAsFolder(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** True if `path` lives inside a Solus-managed worktree (`<root>/.solus-worktrees/<branch>`). */
export function isSolusWorktreePath(path: string): boolean {
  return path.includes(SOLUS_WORKTREE_PATH_MARKER)
}

/** The base project root for a worktree path, or `path` unchanged when it isn't a worktree. */
export function worktreeProjectRoot(path: string): string {
  const idx = path.indexOf(SOLUS_WORKTREE_PATH_MARKER)
  return idx === -1 ? path : path.slice(0, idx)
}

/** `SOLUS_WORKTREE_PATH_MARKER` as it appears inside an encoded Claude folder name. */
export const SOLUS_WORKTREE_ENCODED_MARKER = encodePathAsFolder(SOLUS_WORKTREE_PATH_MARKER)

export interface TabGitContext {
  /** The branch or worktree branch the session is running in */
  branch: string
  /** Remote default branch — always present so DiffPanel always has a diff target */
  targetBranch: string
  /** Only present when running in worktree isolation */
  worktreePath?: string
  /** Absolute path of the git repo root (rev-parse --show-toplevel) */
  repoRoot?: string
}

export function tabGitContextFromStatus(
  status: GitProjectStatus | null | undefined,
  worktreePath?: string,
): TabGitContext | null {
  if (!status?.branch) return null
  return {
    branch: status.branch,
    targetBranch: status.targetBranch,
    repoRoot: status.repoRoot,
    ...(worktreePath ? { worktreePath } : {}),
  }
}

export interface GitCheckoutBranchResult {
  success: boolean
  gitContext?: TabGitContext
  error?: string
}

export interface WorktreeEntry {
  path: string
  branch: string
  lastModified?: number
}

// ─── Automations ───
//
// An Automation is a saved unit of work that submits a prompt to an agent using
// a frozen model / reasoning / permission configuration. Phase 2 adds local,
// time-based triggers (manual / one-time / interval / cron) on top of the Phase 1
// run-now substrate. Scheduling is local-only — triggers fire while Solus is open
// and catch up missed fires on the next launch.

export type AutomationRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

/**
 * What causes an automation to run. Phase 2 ships time-based triggers only
 * (event triggers are a later phase).
 *  - `manual`   — only runs when explicitly triggered (run-now). Phase 1 default.
 *  - `once`     — runs a single time at an absolute instant, then disables itself.
 *  - `interval` — repeats every N minutes while Solus is open.
 *  - `cron`     — repeats on a standard 5-field cron expression in an optional
 *                 IANA timezone (daily/weekly/monthly presets compile to this).
 */
export type AutomationTrigger =
  | { type: 'manual' }
  | { type: 'once'; runAt: string }
  | { type: 'interval'; everyMinutes: number }
  | { type: 'cron'; expr: string; timezone?: string }

export type AutomationTriggerType = AutomationTrigger['type']

/** The frozen "how to run it" config — mirrors the per-session model picker. */
export interface AutomationAction {
  /** The instruction submitted to the agent verbatim (no templating in Phase 1). */
  prompt: string
  agentProvider: AgentId
  /** null → the agent's default model. */
  modelId: string | null
  reasoningEffort: ReasoningEffort
  /** Working directory the run executes in. */
  cwd: string
  /**
   * When set, the run is dispatched *into this existing agent session* — it
   * resumes that chat thread with full conversation context and posts its prompt
   * as an in-thread message (badged "Sent via automation") rather than spawning
   * an isolated headless run. This is what powers "check every minute in this
   * chat" heartbeat automations. The id is the originating session's
   * agentSessionId, captured at create time. `useWorktree` is ignored for these.
   */
  sessionId?: string
  /**
   * When true, the run executes in a fresh git worktree branched off `cwd`
   * instead of mutating the working directory directly. Isolates unattended
   * changes so the user can review them as a branch.
  */
  useWorktree?: boolean
  /**
   * Plan references embedded in the prompt (via `#`). Resolved to context
   * blocks when the run fires. The plan source (file path or content) is
   * captured at save time because a headless run can't locate it otherwise.
   */
  planRefs?: AutomationPlanRef[]
  /**
   * Work/doc references embedded in the prompt (via `%`). Their on-disk path is
   * derived fresh at run time so the agent always reads the latest version.
   */
  workRefs?: WorkReference[]
}

/** A plan reference stored on an automation, with its source resolved at save. */
export interface AutomationPlanRef {
  planId: string
  title: string
  /** Path to the plan markdown the agent should read, when known. */
  filePath?: string
  /** Inline plan content — used as a fallback when no file path exists. */
  content?: string
}

/** Provenance — who authored the automation (a human via UI, or an agent). */
export interface AutomationCreator {
  kind: 'user' | 'agent'
  agentProvider?: AgentId
  sessionId?: string
}

export interface Automation {
  id: string
  name: string
  enabled: boolean
  /** User-pinned to the top of the list. Defaults to false. */
  favorite?: boolean
  action: AutomationAction
  /** What causes the automation to run. Defaults to `{ type: 'manual' }`. */
  trigger: AutomationTrigger
  /**
   * Next scheduled fire as an ISO-8601 UTC instant. Undefined for manual
   * triggers and for one-time triggers that have already fired. The scheduler
   * persists this so a fire missed while the app was closed is caught up on the
   * next launch (a stale `nextRunAt <= now` means "overdue → run once now").
   */
  nextRunAt?: string
  createdAt: string
  updatedAt: string
  createdBy: AutomationCreator
  lastRunId?: string
  lastRunStatus?: AutomationRunStatus
  lastRunAt?: string
}

/** One execution instance of an automation. */
export interface AutomationRun {
  id: string
  automationId: string
  startedAt: string
  finishedAt?: string
  status: AutomationRunStatus
  /** Final assistant text captured from the run. */
  output?: string
  /** Session id of the spawned agent run, for opening it as a session later. */
  agentSessionId?: string | null
  /** Populated when status is 'failed'. */
  error?: string
}

export interface AutomationsManifest {
  version: 1
  automations: Record<string, Automation>
}

// ─── Git provider integration ───
// Renderer-facing surface for the code-host provider adapter (see
// src/main/providers). Only the auth-status shapes cross the IPC boundary; the
// host-neutral review DTOs (PullRequestSummary, ReviewThread, …) live in
// src/main/providers/types.ts and never reach the renderer until PR review mode.

/** Code-host providers we can authenticate against. GitHub only for v1. */
export type ProviderId = 'github'

export interface AuthStatus {
  connected: boolean
  /** Host username, cached after the first authenticated `/user` call. */
  login?: string
  scopes?: string[]
}

/** Device-flow prompt streamed to the renderer while `providerConnect` polls. */
export interface DeviceCodePrompt {
  userCode: string
  verificationUri: string
  expiresIn: number
}

export * from './git-types'
export * from './run-types'
export * from './merge-queue-types'

// IPC channel constants moved to `shared/rpc.ts` (RPC_INVOKE_METHODS,
// RPC_SEND_METHODS, RPC_TOPICS). Both transports — Electron IPC and the
// WebSocket transport for browser clients — dispatch through a single
// envelope `{ method, args }` on one channel each.
