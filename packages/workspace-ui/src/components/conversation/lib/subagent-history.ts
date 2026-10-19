import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { Message } from '@solus/contracts/types'

/** The host already removed ordinary tool output. Keep the recorded child rows
 * and correlate results so a saved child reads like the live child feed. */
export function providerSubagentMessages(rows: WireSessionLoadMessage[]): Message[] {
  const messages: Message[] = []
  const tools = new Map<string, Message>()
  for (const row of rows) {
    if (row.role === 'tool_result') {
      const tool = row.toolResultForId ? tools.get(row.toolResultForId) : undefined
      if (tool) {
        tool.toolStatus = row.status === 'error' ? 'error' : 'completed'
        tool.toolCompletedAt = row.timestamp
        tool.report = row.report
        tool.errorHead = row.errorHead
        tool.contentBytes = row.contentBytes
      }
      continue
    }
    if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'tool' && row.role !== 'system' && row.role !== 'plan') continue
    const message: Message = {
      id: row.messageId ?? `child:${messages.length}:${row.timestamp}`,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      toolName: row.toolName,
      toolId: row.toolId,
      toolInput: row.toolInput,
      toolStatus: row.toolStatus,
      report: row.report,
      errorHead: row.errorHead,
      contentBytes: row.contentBytes,
      subagentType: row.subagentType,
    }
    messages.push(message)
    if (row.toolId) tools.set(row.toolId, message)
  }
  return messages
}
