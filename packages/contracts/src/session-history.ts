import type { AgentId, ContextCompaction, ExchangeProgress, SessionDescription, WatchSessionResult, PromptImageRef, PromptSender, QuestionAnswer, ToolResultAudio, ToolResultImage } from './types'
import type { SessionReport } from './session-exchange'
import type { SecretOutcomeRecord } from './secret-request'
import type { Activity } from './activity'
import type { ArtifactLayout } from './artifact-page'
import type { SavedMessageBody, SavedToolBody } from './session-feed-item'

/** Opaque host cursor. A page is the `turnLimit` newest user turns before the
 * cursor, and it starts at a user turn. Once it holds `HISTORY_PAGE_ROWS` rows
 * or `HISTORY_PAGE_BYTES` bytes it ends at the next turn start, so a turn
 * arrives whole and the rows a client already shows never change their turn.
 * Only a turn past `historyPageMustCut` is cut at a row boundary: its page
 * starts inside the turn, and the next older page holds its earlier rows. A
 * tool result or a child agent's row can then arrive one page before the call
 * that owns it, so a client keeps such rows until an older page brings the
 * call. */
export interface SessionHistoryPageRequest {
  sessionId: string
  projectPath?: string
  provider: AgentId
  turnLimit: number
  before?: string
  /** Include contiguous older turns through this message when they fit in one bounded response. */
  throughEntryId?: string
  /** The client reads a saved `render_artifact` HTML from its work when the
   *  frame mounts, so the page leaves it out and names its `toolInputKey`.
   *  A compiled render is 100–300 KB, and a page carries every revision. */
  deferArtifactHtml?: boolean
  /** Hashes of groups of rows held by this reader. Only these clients receive a historyBlocks manifest. */
  knownHistoryBlocks?: string[]
  /** Join the settled session when this authorized opening page is still current. */
  watchIfHistoryRevision?: string
  /** Include the description and join the requesting reader to a settled session. Opening page only. */
  openSession?: boolean
  /** Include layout for HTML pages inside assistant replies. */
  replyLayout?: boolean
  /** Return composer file paths separately from the text of the prompt. */
  promptFiles?: boolean
  /** Send T3 turn-item bodies alongside Solus history metadata. */
  turnItems?: boolean
}

/** The rows after which a history page ends at its next turn start. */
export const HISTORY_PAGE_ROWS = 500
/** The bytes after which a history page ends at its next turn start, counted
 *  on the rows as returned. */
export const HISTORY_PAGE_BYTES = 1024 * 1024
/** How many budgets one turn may fill before its page is cut inside it. */
const HISTORY_TURN_CUT_BUDGETS = 4

/** Whether a page that holds `rows` rows of `bytes` bytes is full: it ends at
 *  the next turn start. */
export function historyPageIsFull(rows: number, bytes: number): boolean {
  return rows >= HISTORY_PAGE_ROWS || bytes >= HISTORY_PAGE_BYTES
}

/** Whether a page is so far past its budget that it is cut inside a turn. One
 *  agent turn of thousands of tool calls would freeze a client that loads it
 *  whole when the session opens. */
export function historyPageMustCut(rows: number, bytes: number): boolean {
  return rows >= HISTORY_PAGE_ROWS * HISTORY_TURN_CUT_BUDGETS
    || bytes >= HISTORY_PAGE_BYTES * HISTORY_TURN_CUT_BUDGETS
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

/** A turn whose diff the Solus API holds (`sessionTurnDiff`), and when the turn ended. A reader joins it to a turn of its page by time. */
export interface SessionTurnDiffRef {
  turnIndex: number
  endedAt: number
}

/** Each hash covers the complete wire representation of its rows. Blocks marked
 * reused are omitted from the wire messages and restored before projection. */
export interface HistoryBlock {
  hash: string
  count: number
  reused?: true
}

export interface SessionHistoryPage {
  /** Hash of the ordered blocks, earlier cursor and turn diffs. Stable across host restarts. */
  historyRevision?: string
  /** Live state for this connection only. Never persist it with the page. */
  resumedWatch?: WatchSessionResult
  /** Connection-scoped opening metadata. Never persist it with the page. */
  openingDescription?: SessionDescription
  historyBlocks?: HistoryBlock[]
  messages: WireSessionLoadMessage[]
  before: string | null
  /** The turn diffs of the turns on this page. Only a page that the Solus API reads from the mirror has them. */
  turnDiffs?: SessionTurnDiffRef[]
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
  /** A provider checkpoint for a saved assistant response. */
  forkPointId?: string
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
  /** The agent or automation that sent a user turn, from the host's record. */
  sender?: PromptSender
  /** Images a tool returned: on a `tool_result` row, or on a `tool` row that
   *  carries its own output (Codex). */
  toolImages?: ToolResultImage[]
  /** Audio a tool returned, on the same rows as `toolImages`. */
  toolAudio?: ToolResultAudio[]
  /** What the host left out of that tool result, with the limit. */
  toolLeftOut?: string[]
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
  /** The position in a `start_sessions` call's `sessions` list of the session it started. */
  item?: number
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

/** Solus replies written before layout was recorded have no author-specified
 * height. They get a scrollable preview of a fixed size, including on reopen. */
export const UNMEASURED_REPLY_HEIGHT = 320

/** Offsets in the original reply, in UTF-16 code units. Only a complete top-level
 * HTML fence with a literal body has this projection. */
export interface ReplyHtmlLayout {
  attachmentId: string
  start: number
  end: number
  bodyStart: number
  bodyEnd: number
  title: string
  height: number
  heights?: Array<readonly [width: number, height: number]>
}

/** A height a client measured for a reply's HTML frame at one frame width.
 *  `attachmentId` is the frame's id from the page's `replyHtmlLayout`. */
export interface ArtifactFrameHeightReport {
  sessionId: string
  attachmentId: string
  width: number
  height: number
}

/** History row shape allowed across the host-to-client boundary. */
export interface WireSessionLoadMessage extends Omit<SessionLoadMessage, 'toolResultIsError'> {
  /** On projected user rows, content holds only the typed text. */
  attachedFilePaths?: string[]
  /** When requested, a message's text travels in this body and content is empty.
   * A dynamic tool's canonical JSON input can travel here in place of toolInput. */
  turnItem?: SavedMessageBody | SavedToolBody
  replyHtmlLayout?: ReplyHtmlLayout[]
  /** Existing question-tool output, retained for answer details on reload. */
  questionResult?: string
  /** A `request_secret` call's outcomes: names and statuses, never a ref or a path. */
  secretOutcomes?: SecretOutcomeRecord[]
  /** Content key for a tool input left on the host until its summary is opened. */
  toolInputKey?: string
  /** Image read by this saved call, before its full input was deferred. */
  viewedImagePath?: string
  /** A subagent's answer, separated from ordinary tool output. */
  report?: string
  status?: 'ok' | 'error'
  errorHead?: string
  contentBytes?: number
  /** Structured correlation facts extracted before tool output is discarded:
   *  one for each exchange the row opened. A `start_sessions` call opens one for each session. */
  agentConversationResults?: AgentConversationResultProjection[]
  /** Stable work identity from a successful artifact tool result, and the
   *  content version the call wrote, when the receipt names one. `layout` is
   *  the frame the host measured for that version, on pages that ask for reply layout. */
  artifactWorkRef?: { workId: string; title: string; contentVersion?: number; layout?: ArtifactLayout }
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
  target?: import('./session-search').SessionSearchTarget
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
  hitMessageId?: number
  messages: SessionIndexedMessage[]
  hiddenBefore: number
  hiddenAfter: number
}
