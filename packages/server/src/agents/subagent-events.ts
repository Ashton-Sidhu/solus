import type { NormalizedEvent } from '@solus/contracts/types'

export type SubagentTranscriptEvent = Extract<NormalizedEvent, {
  type:
    | 'text_chunk'
    | 'assistant_message'
    | 'thinking'
    | 'tool_call'
    | 'tool_call_update'
    | 'tool_call_complete'
    | 'tool_result'
    | 'progress'
}>

export function isSubagentTranscriptEvent(event: NormalizedEvent): event is SubagentTranscriptEvent {
  switch (event.type) {
    case 'text_chunk':
    case 'assistant_message':
    case 'thinking':
    case 'tool_call':
    case 'tool_call_update':
    case 'tool_call_complete':
    case 'tool_result':
    case 'progress':
      return true
    default:
      return false
  }
}

export function parentSubagentEvent(
  event: SubagentTranscriptEvent,
  parentToolUseId: string,
): SubagentTranscriptEvent {
  return { ...event, parentToolUseId }
}
