import type { Message } from '@solus/contracts/types'
import type { ToolHistoryStore } from '../../../contexts/workspace/tool-history.store'

/** Called only by a copy action: no formatting or history reads during render. */
export async function toolRowsCopyText(messages: Message[], history?: ToolHistoryStore): Promise<string> {
  await history?.load(messages)
  return messages.map((message) => {
    if (message.historyToolInput) {
      throw new Error(message.historyToolInput.error ?? 'Tool details are not available yet. Try again.')
    }
    return [
      `${message.toolName || 'Tool'}${message.toolStatus ? ` (${message.toolStatus})` : ''}`,
      message.toolInput,
      message.errorHead,
    ].filter(Boolean).join('\n\n')
  }).join('\n\n---\n\n')
}
