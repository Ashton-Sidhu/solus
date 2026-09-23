import type { AgentId } from './types'

/** Opaque host cursor. Pages contain complete turns so tool results never
 * arrive without their calls. The limit is a target, not a hard row cap. */
export interface SessionHistoryPageRequest {
  sessionId: string
  projectPath?: string
  provider: AgentId
  limit?: number
  before?: string
  deferToolInputs?: boolean
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
  /** Stable identity for synthetic rows derived from Solus-owned lineage. */
  messageId?: string
  role: string
  content: string
  /** Inline provider-history images needed to rebuild a user turn after reload. */
  imageAttachments?: Array<{ mimeType: string; dataUrl: string }>
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
  /** Destination label for a deterministic provider-handoff divider. */
  agentChangedTo?: string
  /** Model labels for the provider-handoff divider, when indexed metadata has them. */
  agentChangedFromModel?: string
  agentChangedToModel?: string
  agentChangedFromProvider?: AgentId
  agentChangedToProvider?: AgentId
  timestamp: number
}

export interface AgentConversationResultProjection {
  agentSessionId?: string
  watcherRegistered?: boolean
  /** The exchange the tool opened; live updates and reports name the same id. */
  messageId?: string
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
  /** Stable work identity from a successful artifact tool result. */
  artifactWorkRef?: { workId: string; title: string }
  /** A legacy update receipt can identify success without naming the work type. */
  workUpdateSucceeded?: boolean
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
