// ─── Claude Code raw SDK event types ───
// These are specific to the Claude Agent SDK stream format.
// Shared/canonical types (NormalizedEvent, etc.) stay in types.ts.

import type { PermissionOption } from './types'

export interface ContentBlock {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

export type ContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }

export interface ClaudeUsageData {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  reasoning_output_tokens?: number
}

export interface AssistantMessagePayload {
  model: string
  id: string
  role: 'assistant'
  content: ContentBlock[]
  stop_reason: string | null
  usage: ClaudeUsageData
}

export interface InitEvent {
  type: 'system'
  subtype: 'init'
  cwd: string
  session_id: string
  tools: string[]
  mcp_servers: Array<{ name: string; status: string }>
  model: string
  permissionMode: string
  agents: string[]
  skills: string[]
  plugins: string[]
  claude_code_version: string
  fast_mode_state: string
  uuid: string
}

export interface StreamEvent {
  type: 'stream_event'
  event: StreamSubEvent
  session_id: string
  parent_tool_use_id: string | null
  uuid: string
}

export type StreamSubEvent =
  | { type: 'message_start'; message: AssistantMessagePayload }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string | null }; usage: ClaudeUsageData; context_management?: unknown }
  | { type: 'message_stop' }

export interface AssistantEvent {
  type: 'assistant'
  message: AssistantMessagePayload
  parent_tool_use_id: string | null
  session_id: string
  uuid: string
}

/**
 * Sub-agent and tool-result payloads. The SDK streams a spawned sub-agent's
 * inner transcript back as `type:'user'` messages tagged with
 * `parent_tool_use_id`, and the parent Agent tool's own result lands the same
 * way. The content is a block array carrying `tool_result` blocks.
 */
export interface UserEvent {
  type: 'user'
  message: { role: 'user'; content: UserContentBlock[] }
  parent_tool_use_id: string | null
  session_id: string
  uuid: string
}

export type UserContentBlock =
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }>; is_error?: boolean }
  | { type: 'text'; text: string }

export interface RateLimitEvent {
  type: 'rate_limit_event'
  rate_limit_info: {
    status: string
    resetsAt: number
    rateLimitType: string
    overageStatus?: string
    overageDisabledReason?: string
    isUsingOverage?: boolean
  }
  session_id: string
  uuid: string
}

export interface ResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  is_error: boolean
  duration_ms: number
  num_turns: number
  result: string
  total_cost_usd: number
  session_id: string
  usage: ClaudeUsageData & {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  permission_denials: string[]
  uuid: string
}

export interface PermissionEvent {
  type: 'permission_request'
  tool: { name: string; description?: string; input?: Record<string, unknown> }
  question_id: string
  options: PermissionOption[]
  session_id: string
  uuid: string
}

export interface StatusEvent {
  type: 'system'
  subtype: 'status'
  status: string | null
  permissionMode: string
  uuid: string
  session_id: string
}

export type ClaudeEvent = InitEvent | StatusEvent | StreamEvent | AssistantEvent | UserEvent | RateLimitEvent | ResultEvent | PermissionEvent | UnknownEvent

export interface UnknownEvent {
  type: string
  [key: string]: unknown
}
