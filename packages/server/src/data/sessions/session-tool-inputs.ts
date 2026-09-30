import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SessionLoadMessage, WireSessionLoadMessage, SessionToolInput } from '@solus/contracts/session-history'

// These inputs reconstruct visible cards or subagent metadata during replay.
// Ordinary tool rows need only their name/status until the summary is opened.
const CARD_INPUT_TOOLS = [
  'create_work', 'render_artifact', 'update_work', 'create_automation', 'update_automation',
  'start_session', 'send_session', 'stop_session',
  'AskUserQuestion', 'request_user_input',
  'claude_subagent', 'codex_subagent', 'spawnAgent',
]

function inputKey(message: Pick<SessionLoadMessage, 'toolName' | 'toolInput'>): string {
  return createHash('sha256').update(message.toolName ?? '').update('\0').update(message.toolInput ?? '').digest('hex')
}

/** A string longer than this is content — a file body, a patch, a heredoc —
 *  not a fact a folded row or the changed-files list reads. */
const SUMMARY_STRING_LIMIT = 256
const longString = z.string().min(SUMMARY_STRING_LIMIT + 1)

/** The input with its shape kept and every long string dropped: paths, the
 *  command, and the stated intent stay; what they act on does not. A folded
 *  turn can still count its files, and the changed-files list still finds
 *  them. The full input loads when the reader opens the row. Null when there
 *  is nothing long to leave behind; undefined when the input is not JSON. */
function summarizeToolInput(toolInput: string): string | null | undefined {
  let dropped = false
  try {
    const summary = JSON.stringify(JSON.parse(toolInput), (_key, value) => {
      if (!longString.safeParse(value).success) return value
      dropped = true
      return undefined
    })
    return dropped ? summary : null
  } catch {
    return undefined
  }
}

/** Every history page defers ordinary tool inputs: on a busy session they are
 *  most of the page, and a reader opens few of them. */
export function deferSessionToolInputs(messages: WireSessionLoadMessage[]): WireSessionLoadMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool' || !message.toolInput || message.isSubagent || message.parentToolUseId
      || message.toolStatus === 'running' || message.toolStatus === 'error' || message.status === 'error'
      || message.toolName === 'ImageGeneration'
      || message.toolName === 'Task' || message.toolName === 'Agent'
      || CARD_INPUT_TOOLS.some((name) => message.toolName?.endsWith(name))) return message
    const { toolInput, ...rest } = message
    const summary = summarizeToolInput(toolInput)
    if (summary === null) return message
    const deferred: WireSessionLoadMessage = { ...rest, toolInputKey: inputKey(message) }
    if (summary !== undefined) deferred.toolInput = summary
    return deferred
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
