import { createHash } from 'node:crypto'
import type { SessionLoadMessage, WireSessionLoadMessage, SessionToolInput } from '@solus/contracts/session-history'

// These inputs reconstruct visible cards or subagent metadata during replay.
// Ordinary tool rows need only their name/status until the summary is opened.
const CARD_INPUT_TOOLS = [
  'create_work', 'render_artifact', 'create_automation', 'update_automation',
  'create_session', 'prompt_session', 'wait_for_session', 'stop_session',
  'claude_subagent', 'codex_subagent', 'spawnAgent',
]

function inputKey(message: Pick<SessionLoadMessage, 'toolName' | 'toolInput'>): string {
  return createHash('sha256').update(message.toolName ?? '').update('\0').update(message.toolInput ?? '').digest('hex')
}

export function deferSessionToolInputs(messages: WireSessionLoadMessage[]): WireSessionLoadMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool' || !message.toolInput || message.isSubagent || message.parentToolUseId
      || message.toolStatus === 'running' || message.toolStatus === 'error' || message.status === 'error'
      || message.toolName === 'ImageGeneration'
      || message.toolName === 'Task' || message.toolName === 'Agent'
      || CARD_INPUT_TOOLS.some((name) => message.toolName?.endsWith(name))) return message
    const { toolInput: _input, ...summary } = message
    return { ...summary, toolInputKey: inputKey(message) }
  })
}

/** Keys include the input content: appended, rewound, or changed history cannot
 * silently return another tool's input. Only the requested inputs cross the wire. */
export function selectSessionToolInputs(messages: SessionLoadMessage[], keys: string[]): SessionToolInput[] {
  const pending = new Set(keys)
  const result: SessionToolInput[] = []
  for (const message of messages) {
    if (message.role !== 'tool' || !message.toolInput) continue
    const key = inputKey(message)
    if (!pending.delete(key)) continue
    result.push({ key, toolInput: message.toolInput })
    if (pending.size === 0) break
  }
  return result
}
