import type { Message } from '@solus/contracts/types'
import type { TimelineTurn } from '@solus/client-core/turn-timeline'
import { isAgentNotice } from '../../../../contexts/workspace/session.utils'

/**
 * What the Artifacts surface reads off a session's transcript
 * (docs/plans/session-artifacts.md): its turns, when each tool call started,
 * and the messages that carry an agent. One pass, so the surface reads the
 * transcript once per appended message and not once per fact.
 */
export interface SessionActivity {
  /** A turn ends at the last thing seen in it. The caller ends a live turn at the present moment. */
  turns: TimelineTurn[]
  toolCallTimes: number[]
  /** Where each turn's prompt is in the messages, so one turn's messages can be read alone. */
  promptIndexes: number[]
  /** A sub-agent's tool call, or the card of a session this one started or messaged. */
  agentMessages: Message[]
}

const PROMPT_PREVIEW_LENGTH = 240

/** A prompt as one line: its text with the line breaks folded, cut where a caption stops reading. */
function promptPreview(content: string): string {
  const line = content.replace(/\s+/g, ' ').trim()
  return line.length > PROMPT_PREVIEW_LENGTH ? `${line.slice(0, PROMPT_PREVIEW_LENGTH - 1)}…` : line
}

/**
 * A prompt opens a turn, as the conversation cuts them: a notice the agent SDK
 * injected is not one. What comes before the first prompt belongs to no turn.
 */
export function scanSessionActivity(messages: readonly Message[]): SessionActivity {
  const activity: SessionActivity = { turns: [], toolCallTimes: [], promptIndexes: [], agentMessages: [] }
  let turn: TimelineTurn | null = null
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if ((message.role === 'tool' && message.subMessages) || message.agentConversationRef) activity.agentMessages.push(message)
    if (message.role === 'user' && !isAgentNotice(message.content)) {
      turn = { id: message.id, startedAt: message.timestamp, endedAt: message.timestamp, prompt: promptPreview(message.content) }
      activity.turns.push(turn)
      activity.promptIndexes.push(index)
      continue
    }
    if (!turn) continue
    turn.endedAt = Math.max(turn.endedAt, message.timestamp, message.toolCompletedAt ?? 0)
    if (message.role === 'tool') activity.toolCallTimes.push(message.timestamp)
  }
  return activity
}

/** The messages of one turn: from its prompt up to the next prompt. */
export function turnMessages(messages: readonly Message[], activity: SessionActivity, turnIndex: number): Message[] {
  return messages.slice(activity.promptIndexes[turnIndex], activity.promptIndexes[turnIndex + 1])
}
