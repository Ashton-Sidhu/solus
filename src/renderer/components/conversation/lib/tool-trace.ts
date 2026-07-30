import type { Message } from '../../../../shared/types'

export interface ToolTracePayload {
  text: string
  language: 'json' | 'text'
}

function payload(text: string | undefined): ToolTracePayload | null {
  if (!text) return null
  try {
    return {
      text: JSON.stringify(JSON.parse(text), null, 2),
      language: 'json',
    }
  } catch {
    return { text, language: 'text' }
  }
}

export function toolTraceInput(tool: Message): ToolTracePayload | null {
  return payload(tool.toolInput)
}

export function toolTraceOutput(tool: Message): ToolTracePayload | null {
  return payload(tool.toolResult ?? tool.content)
}

export function toolTraceStatus(tool: Message): 'Running' | 'Failed' | 'Completed' {
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
