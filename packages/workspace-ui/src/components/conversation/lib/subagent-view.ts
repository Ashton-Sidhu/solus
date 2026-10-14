import type { Message } from '@solus/contracts/types'
import { parseSubagentInput, subagentInputText } from './subagent'
import { subagentState } from './subagent-group'

/**
 * The sub-agent pane reads a sub-agent's run as a conversation with no input
 * bar: the brief the main agent wrote is the prompt, then what the sub-agent
 * did and said, then its answer.
 */

/**
 * The agent's answer. A blocking agent delivers it as the tool result; a
 * backgrounded one never returns one at all, so its last assistant block in its
 * own transcript *is* the answer.
 */
export function reportText(message: Message): string {
  // Assistant prose emitted while the agent is still working is progress, not
  // its answer.
  if (subagentState(message) === 'running') return ''

  const result = message.report?.trim()
  if (result) return result
  return (message.subMessages ?? [])
    .findLast((m) => m.role === 'assistant' && m.content.trim())
    ?.content.trim() ?? ''
}

/** The run as conversation messages, in the order they happened. */
export function subagentConversation(message: Message): Message[] {
  const subs = message.subMessages ?? []
  const messages: Message[] = []
  const brief = subagentInputText(parseSubagentInput(message.toolInput)).trim()
  // Some providers keep the brief in the sub-agent's own transcript.
  if (brief && !subs.some((m) => m.role === 'user')) {
    messages.push({ id: `${message.id}:brief`, role: 'user', content: brief, timestamp: message.timestamp })
  }
  messages.push(...subs)
  // A blocking agent's answer arrives as the tool result, not in its transcript.
  const report = reportText(message)
  const lastProse = subs.findLast((m) => m.role === 'assistant' && m.content.trim())?.content.trim()
  if (report && report !== lastProse) {
    messages.push({
      id: `${message.id}:report`,
      role: 'assistant',
      content: report,
      timestamp: message.toolCompletedAt ?? message.timestamp,
    })
  }
  return messages
}
