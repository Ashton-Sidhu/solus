export interface SessionLoadMessage {
  role: string
  content: string
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
  timestamp: number
}

export interface AgentConversationResultProjection {
  agentSessionId?: string
  watcherRegistered?: boolean
}

/** History row shape allowed across the host-to-client boundary. */
export interface WireSessionLoadMessage extends Omit<SessionLoadMessage, 'toolResultIsError'> {
  /** A subagent's answer, separated from ordinary tool output. */
  report?: string
  status?: 'ok' | 'error'
  errorHead?: string
  contentBytes?: number
  /** Structured correlation facts extracted before tool output is discarded. */
  agentConversationResult?: AgentConversationResultProjection
}

export interface SessionPreviewResult {
  head: SessionLoadMessage[]
  tail: SessionLoadMessage[]
  totalMessages: number
}
