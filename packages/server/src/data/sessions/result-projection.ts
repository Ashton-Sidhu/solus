import { isQuestionTool } from '@solus/contracts/question-history'
import { parseExchangeTag, parseOrchestrationItems } from '@solus/contracts/session-exchange'
import type { NormalizedEvent, WireNormalizedEvent } from '@solus/contracts/types'
import type { AgentConversationResultProjection, SessionLoadMessage, WireSessionLoadMessage } from '@solus/contracts/session-history'

export const ERROR_HEAD_MAX_BYTES = 2 * 1024

interface AgentConversationProjection {
  agentConversationResult?: AgentConversationResultProjection
}

export function serializedBytes<T>(value: T): number {
  return Buffer.byteLength(JSON.stringify(value))
}

export function projectSessionEvent(event: NormalizedEvent): WireNormalizedEvent | null {
  if (event.type === 'tool_result') {
    if (event.isAsyncLaunch && !event.isError) return null
    if (event.isSubagentReport || event.toolUseId === event.parentToolUseId) {
      const projected: WireNormalizedEvent = {
        type: 'subagent_report',
        toolUseId: event.toolUseId,
        text: event.content,
      }
      if (event.isError) projected.isError = true
      return projected
    }
    const projected: WireNormalizedEvent = {
      type: 'tool_result',
      toolUseId: event.toolUseId,
      status: event.isError ? 'error' : 'ok',
      contentBytes: Buffer.byteLength(event.content),
    }
    if (event.parentToolUseId) projected.parentToolUseId = event.parentToolUseId
    if (event.isError) projected.errorHead = utf8Head(event.content)
    return projected
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
      const projected: WireSessionLoadMessage = {
        ...base,
        content: '',
        status,
        contentBytes: Buffer.byteLength(message.content),
      }
      if (toolResultIsError) projected.errorHead = utf8Head(message.content)
      if (isQuestionTool(toolName) && message.content) projected.questionResult = utf8Head(message.content)
      Object.assign(projected, agentConversationProjection(toolName, message.content))
      Object.assign(projected, artifactProjection(toolName, message.content, toolResultIsError))
      return projected
    }

    if (message.role !== 'tool' || !message.content) return message

    if (isSubagentTool(message)) {
      return { ...message, content: '', report: message.content, status: message.toolStatus === 'error' ? 'error' : 'ok' }
    }

    const projected: WireSessionLoadMessage = {
      ...message,
      content: '',
      status: message.toolStatus === 'error' ? 'error' : 'ok',
      contentBytes: Buffer.byteLength(message.content),
    }
    if (message.toolStatus === 'error') projected.errorHead = utf8Head(message.content)
    if (isQuestionTool(message.toolName)) projected.questionResult = utf8Head(message.content)
    Object.assign(projected, agentConversationProjection(message.toolName, message.content))
    Object.assign(projected, artifactProjection(message.toolName, message.content, message.toolStatus === 'error'))
    return projected
  })
}

function artifactProjection(toolName: string | undefined, content: string, failed?: boolean): Pick<WireSessionLoadMessage, 'artifactWorkRef' | 'workUpdateSucceeded'> {
  if (failed) return {}
  const match = toolName?.endsWith('render_artifact')
    ? /Rendered "([\s\S]*?)" in the conversation and saved it as an artifact \(id: ([^\s)]+)\)/.exec(content)
    : toolName?.endsWith('update_work')
      ? /Updated "([\s\S]*?)" \(artifact, id: ([^\s)]+)\)/.exec(content)
      : null
  const result: Pick<WireSessionLoadMessage, 'artifactWorkRef' | 'workUpdateSucceeded'> = {}
  if (match) result.artifactWorkRef = { title: match[1], workId: match[2] }
  if (toolName?.endsWith('update_work') && content.startsWith('Updated "')) result.workUpdateSucceeded = true
  return result
}

function isSubagentTool(message: Pick<SessionLoadMessage, 'isSubagent' | 'toolName'>): boolean {
  if (message.isSubagent) return true
  const name = message.toolName?.slice(message.toolName.lastIndexOf('.') + 1)
  return name === 'Task' || name === 'Agent' || name === 'spawnAgent'
    || name === 'claude_subagent' || name === 'codex_subagent'
}

/** The exchange a start_session or send_session result opened, read with
 *  the one codec the host writes it with. */
function agentConversationProjection(
  toolName: string | undefined,
  content: string,
): AgentConversationProjection {
  if (!toolName?.endsWith('start_session') && !toolName?.endsWith('send_session')) return {}
  const tag = parseExchangeTag(content)
  if (!tag) return {}
  // A created session's card needs the session the tool started; a prompt names it in its input.
  if (toolName.endsWith('start_session') && !tag.agentSessionId) return {}
  const agentConversationResult: AgentConversationResultProjection = {}
  if (tag.agentSessionId) agentConversationResult.agentSessionId = tag.agentSessionId
  if (tag.messageId) agentConversationResult.messageId = tag.messageId
  if (tag.provider) agentConversationResult.provider = tag.provider
  // A call that waited may carry the exchange's report: no report turn follows.
  const report = parseOrchestrationItems(content)?.find((item) => item.type === 'report' && item.report.messageId === tag.messageId)
  if (report?.type === 'report') agentConversationResult.report = report.report
  return { agentConversationResult }
}

function utf8Head(content: string): string {
  const bytes = new TextEncoder().encode(content)
  if (bytes.byteLength <= ERROR_HEAD_MAX_BYTES) return content
  return new TextDecoder().decode(bytes.subarray(0, ERROR_HEAD_MAX_BYTES), { stream: true })
}
