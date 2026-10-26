import type { AgentId, ContextCompaction, ExchangeProgress, PromptImageRef, QuestionAnswer, ToolResultImage } from './types'
import type { SessionReport } from './session-exchange'
import type { Activity } from './activity'

/** Opaque host cursor. A page is the `turnLimit` newest user turns before the
 * cursor, but never more than `HISTORY_PAGE_ROWS` rows or `HISTORY_PAGE_BYTES`
 * bytes. Ordinary turns arrive whole. A turn longer than the budget is cut at
 * a row boundary: its page starts inside the turn, and the next older page
 * holds its earlier rows. A tool result or a child agent's row can then arrive
 * one page before the call that owns it, so a client keeps such rows until an
 * older page brings the call. */
export interface SessionHistoryPageRequest {
  sessionId: string
  projectPath?: string
  provider: AgentId
  turnLimit: number
  before?: string
  /** The client reads a saved `render_artifact` HTML from its work when the
   *  frame mounts, so the page leaves it out and names its `toolInputKey`.
   *  A compiled render is 100–300 KB, and a page carries every revision. */
  deferArtifactHtml?: boolean
}

/** The most rows one history page holds. Enough that ordinary turns stay whole. */
export const HISTORY_PAGE_ROWS = 500
/** The most stored bytes one history page reads, counted on the rows as read. */
export const HISTORY_PAGE_BYTES = 1024 * 1024

/** Whether a page that holds `rows` rows read from `bytes` stored bytes is full. */
export function historyPageIsFull(rows: number, bytes: number): boolean {
  return rows >= HISTORY_PAGE_ROWS || bytes >= HISTORY_PAGE_BYTES
}

/** The row a user turn starts at: a prompt from the user, not a tool result
 *  or a child agent's message. Pages are counted and cut at these rows. */
export function startsHistoryTurn(message: Pick<SessionLoadMessage, 'role' | 'parentToolUseId'>): boolean {
  return message.role === 'user' && !message.parentToolUseId
}

/** Read a provider child through the parent tool that owns it. The host resolves
 * the child identity; clients cannot name an unrelated provider thread. */
export interface SessionSubagentRequest {
  sessionId: string
  toolId: string
  provider: AgentId
  projectPath?: string
  before?: string
}

export interface SessionHistoryPage {
  messages: WireSessionLoadMessage[]
  before: string | null
}

export interface ProviderHistoryPage {
  messages: SessionLoadMessage[]
  before: string | null
}

export interface SessionLoadMessage {
  sourceProvider?: AgentId
  sourceSessionId?: string
  questionAnswer?: QuestionAnswer
  /** Stable provider identity or identity for a Solus-owned synthetic row. */
  messageId?: string
  role: string
  content: string
  /** The provider refused this turn's login. When it ends the transcript, the client offers sign-in again. */
  loginRefused?: true
  /** Inline provider-history images needed to rebuild a user turn after reload.
   *  A host that stores them sends `imageAttachmentRefs` instead; a row a
   *  runner mirrored earlier may still carry these. */
  imageAttachments?: Array<{ mimeType: string; dataUrl: string }>
  /** A user turn's images as files in the host asset store. */
  imageAttachmentRefs?: PromptImageRef[]
  /** Images a tool returned: on a `tool_result` row, or on a `tool` row that
   *  carries its own output (Codex). */
  toolImages?: ToolResultImage[]
  toolName?: string
  toolId?: string
  toolInput?: string
  toolStatus?: 'running' | 'completed' | 'error'
  isSubagent?: boolean
  subagentType?: string
  toolResultForId?: string
  toolResultIsError?: boolean
  planContent?: string
  planFilePath?: string
  planToolUseId?: string
  /** Set on sub-agent tool-result/text lines so history replay can divert them
   *  into the parent tool's `subMessages` instead of the flat thread. */
  parentToolUseId?: string
  /** A host-recorded activity merged into the history by its time (plans/012 §5),
   *  or a provider handoff the lineage read rebuilt as `agent_switched`. */
  activity?: Activity
  /** A context compaction the provider recorded in its transcript. */
  compaction?: ContextCompaction
  timestamp: number
}

/** The exchange an orchestration tool result opened, read by the shared codec. */
export interface AgentConversationResultProjection {
  /** The session the tool started or messaged. */
  sessionId?: string
  /** The exchange the tool opened; live updates and reports name the same id. */
  messageId?: string
  provider?: AgentId
  /** The id clients know the session's host by, when it runs on another host. */
  serverId?: string
  /** The report a waiting tool call returned: the exchange settled inside the
   *  call, so no report turn follows in the transcript. */
  report?: SessionReport
  /** The host's word on the exchange as of this read. Absent when the host no
   *  longer carries it: a restart ended it, or its receipt expired. */
  progress?: ExchangeProgress
}

/** History row shape allowed across the host-to-client boundary. */
export interface WireSessionLoadMessage extends Omit<SessionLoadMessage, 'toolResultIsError'> {
  /** Existing question-tool output, retained for answer details on reload. */
  questionResult?: string
  /** Content key for a tool input left on the host until its summary is opened. */
  toolInputKey?: string
  /** A subagent's answer, separated from ordinary tool output. */
  report?: string
  status?: 'ok' | 'error'
  errorHead?: string
  contentBytes?: number
  /** Structured correlation facts extracted before tool output is discarded. */
  agentConversationResult?: AgentConversationResultProjection
  /** Stable work identity from a successful artifact tool result, and the
   *  content version the call wrote, when the receipt names one. */
  artifactWorkRef?: { workId: string; title: string; contentVersion?: number }
  /** A legacy update receipt can identify success without naming the work type. */
  workUpdateSucceeded?: boolean
  /** Saved content version from a successful update receipt. */
  workContentVersion?: number
}

export const MAX_SESSION_TOOL_INPUTS = 200

export interface SessionToolInputsRequest {
  sessionId: string
  projectPath?: string
  provider: AgentId
  keys: string[]
}

export interface SessionToolInput {
  key: string
  toolInput: string
}

/** Client-side origin and fetch state retained with a historical tool row. */
export interface DeferredToolInput {
  serverId: string
  sessionId: string
  projectPath?: string
  provider: AgentId
  key: string
  /** The small fields the host sent in place of the full input. The full
   *  input replaces them only while the message still holds exactly these. */
  summary?: string
  loading?: boolean
  error?: string
}

export interface SessionPreviewResult {
  head: SessionLoadMessage[]
  tail: SessionLoadMessage[]
  totalMessages: number
}

/** One message as the search index holds it: the spoken turns only, no tool
 *  traffic, keyed by the row a search hit names. */
export interface SessionIndexedMessage {
  messageId: number
  role: 'user' | 'assistant'
  ts: number | null
  text: string
}

export interface SessionMessageWindowRequest {
  sessionId: string
  /** The message to centre on: the `messageId` of a search hit. */
  messageId: number
  /** How many messages to include on each side of it. */
  radius?: number
}

/** The messages around one message of a session, in transcript order, with
 *  how many the window left out on either side. Empty when the message is no
 *  longer indexed. */
export interface SessionMessageWindow {
  messages: SessionIndexedMessage[]
  hiddenBefore: number
  hiddenAfter: number
}
