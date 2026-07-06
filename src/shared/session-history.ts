export interface SessionLoadMessage {
  role: string
  content: string
  toolName?: string
  toolId?: string
  toolInput?: string
  toolResultForId?: string
  planContent?: string
  planFilePath?: string
  planToolUseId?: string
  /** Set on sub-agent tool-result/text lines so history replay can divert them
   *  into the parent tool's `subMessages` instead of the flat thread. */
  parentToolUseId?: string
  timestamp: number
}

export interface SessionPreviewResult {
  head: SessionLoadMessage[]
  tail: SessionLoadMessage[]
  totalMessages: number
}
