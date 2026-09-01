import type { Message } from '../../../../shared/types'

function toolTraceStatus(tool: Message): 'Running' | 'Failed' | 'Completed' {
  if (tool.toolStatus === 'running') return 'Running'
  if (tool.toolStatus === 'error') return 'Failed'
  return 'Completed'
}

/** Plain-text export of the same observable child events shown in the pane. */
export function subagentTranscriptText(messages: Message[]): string {
  return messages
    .map((message) => {
      if (message.role !== 'tool') return message.content

      const lines = [`Tool: ${message.toolName || 'Tool'}`, `Status: ${toolTraceStatus(message)}`]
      if (message.toolId) lines.push(`Call ID: ${message.toolId}`)
      if (message.toolInput) lines.push(`Input:\n${message.toolInput}`)
      if (message.contentBytes !== undefined) {
        lines.push(`${toolTraceStatus(message) === 'Failed' ? 'Error' : 'Output'}: (${formatBytes(message.contentBytes)}, not shipped)`)
      }
      return lines.join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${Math.round(bytes / 102.4) / 10} KB`
}
