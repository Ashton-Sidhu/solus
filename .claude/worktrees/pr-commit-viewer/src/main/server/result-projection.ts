import type { NormalizedEvent, WireNormalizedEvent } from '../../shared/types'
import type { AgentConversationResultProjection, SessionLoadMessage, WireSessionLoadMessage } from '../../shared/session-history'

export const ERROR_HEAD_MAX_BYTES = 2 * 1024

const AGENT_SESSION_ID = /sessionId=([0-9a-f-]{36})/

export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

export function projectSessionEvent(event: NormalizedEvent): WireNormalizedEvent | null {
  if (event.type === 'tool_result') {
    if (event.isAsyncLaunch && !event.isError) return null
    if (event.isSubagentReport || event.toolUseId === event.parentToolUseId) {
      return {
        type: 'subagent_report',
        toolUseId: event.toolUseId,
        text: event.content,
        ...(event.isError ? { isError: true } : {}),
      }
    }
    return {
      type: 'tool_result',
      toolUseId: event.toolUseId,
      ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
      status: event.isError ? 'error' : 'ok',
      ...(event.isError ? { errorHead: utf8Head(event.content) } : {}),
      contentBytes: Buffer.byteLength(event.content),
    }
  }

  if (event.type === 'tool_call' || event.type === 'tool_call_update') {
    const { content: _content, ...projected } = event
    return projected
  }

  return event
}

export function projectSessionHistory(messages: SessionLoadMessage[]): WireSessionLoadMessage[] {
  const toolNameById = new Map<string, string>()
  const subagentToolIds = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'tool' || !message.toolId) continue
    if (message.toolName) toolNameById.set(message.toolId, message.toolName)
    if (isSubagentTool(message)) subagentToolIds.add(message.toolId)
  }

  return messages.map((message) => {
    if (message.role === 'tool_result') {
      const { toolResultIsError, ...base } = message
      const toolName = message.toolResultForId ? toolNameById.get(message.toolResultForId) : undefined
      const status = toolResultIsError ? 'error' : 'ok'
      if (message.toolResultForId && subagentToolIds.has(message.toolResultForId)) {
        return { ...base, content: '', report: message.content, status }
      }
      return {
        ...base,
        content: '',
        status,
        ...(toolResultIsError ? { errorHead: utf8Head(message.content) } : {}),
        contentBytes: Buffer.byteLength(message.content),
        ...agentConversationProjection(toolName, message.content),
      }
    }

    if (message.role !== 'tool' || !message.content) return message

    if (isSubagentTool(message)) {
      return { ...message, content: '', report: message.content, status: message.toolStatus === 'error' ? 'error' : 'ok' }
    }

    return {
      ...message,
      content: '',
      status: message.toolStatus === 'error' ? 'error' : 'ok',
      ...(message.toolStatus === 'error' ? { errorHead: utf8Head(message.content) } : {}),
      contentBytes: Buffer.byteLength(message.content),
      ...agentConversationProjection(message.toolName, message.content),
    }
  })
}

function isSubagentTool(message: Pick<SessionLoadMessage, 'isSubagent' | 'toolName'>): boolean {
  if (message.isSubagent) return true
  const name = message.toolName?.slice(message.toolName.lastIndexOf('.') + 1)
  return name === 'Task' || name === 'Agent' || name === 'spawnAgent'
    || name === 'claude_subagent' || name === 'codex_subagent'
}

function agentConversationProjection(
  toolName: string | undefined,
  content: string,
): { agentConversationResult?: AgentConversationResultProjection } {
  if (!toolName) return {}
  if (toolName.endsWith('create_session')) {
    const agentSessionId = content.match(AGENT_SESSION_ID)?.[1]
    return agentSessionId ? { agentConversationResult: { agentSessionId } } : {}
  }
  if (toolName.endsWith('wait_for_session') && content.includes('no watcher was registered')) {
    return { agentConversationResult: { watcherRegistered: false } }
  }
  return {}
}

function utf8Head(content: string): string {
  const bytes = new TextEncoder().encode(content)
  if (bytes.byteLength <= ERROR_HEAD_MAX_BYTES) return content
  return new TextDecoder().decode(bytes.subarray(0, ERROR_HEAD_MAX_BYTES), { stream: true })
}
