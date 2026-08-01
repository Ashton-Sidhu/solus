import type { Message } from '../../../../shared/types'

function toolTraceStatus(tool: Message): 'Running' | 'Failed' | 'Completed' {
  if (tool.toolStatus === 'running') return 'Running'
  if (tool.toolStatus === 'error' || tool.toolResultIsError) return 'Failed'
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
      const output = message.toolResult ?? message.content
      if (output) lines.push(`${toolTraceStatus(message) === 'Failed' ? 'Error' : 'Output'}:\n${output}`)
      return lines.join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
}
