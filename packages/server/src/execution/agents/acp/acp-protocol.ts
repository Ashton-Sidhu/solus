import { z } from 'zod'

/**
 * The Agent Client Protocol messages that the ACP backend reads
 * (https://agentclientprotocol.com, protocol version 1). Each object is loose:
 * an agent may add fields, and only the fields here are Solus's business.
 */

export const ACP_PROTOCOL_VERSION = 1

const contentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
})
export type AcpContentBlock = z.infer<typeof contentBlockSchema>

export const initializeResultSchema = z.looseObject({
  protocolVersion: z.number(),
  agentCapabilities: z.looseObject({
    loadSession: z.boolean().optional(),
    promptCapabilities: z.looseObject({ image: z.boolean().optional() }).optional(),
    mcpCapabilities: z.looseObject({ http: z.boolean().optional() }).optional(),
    sessionCapabilities: z.looseObject({ resume: z.looseObject({}).optional() }).optional(),
  }).optional(),
  authMethods: z.array(z.looseObject({ id: z.string(), name: z.string().optional() })).optional(),
  agentInfo: z.looseObject({ name: z.string().optional(), version: z.string().optional() }).optional(),
})
export type AcpInitializeResult = z.infer<typeof initializeResultSchema>

const selectOptionSchema = z.looseObject({ value: z.string(), name: z.string().optional() })
const configOptionSchema = z.looseObject({
  id: z.string(),
  category: z.string().nullish(),
  type: z.string().optional(),
  currentValue: z.unknown().optional(),
  options: z.array(z.union([selectOptionSchema, z.looseObject({ options: z.array(selectOptionSchema) })])).optional(),
})
export type AcpConfigOption = z.infer<typeof configOptionSchema>

/** `session/new`, `session/resume`, and `session/load` all answer with the session's options. */
export const sessionSetupResultSchema = z.looseObject({
  sessionId: z.string().optional(),
  configOptions: z.array(configOptionSchema).nullish(),
  modes: z.looseObject({
    currentModeId: z.string(),
    availableModes: z.array(z.looseObject({ id: z.string() })),
  }).nullish(),
})
export type AcpSessionSetupResult = z.infer<typeof sessionSetupResultSchema>

export const STOP_REASONS = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const
export type AcpStopReason = (typeof STOP_REASONS)[number]
/**
 * A prompt's token counts (`PromptResponse.usage`). ACP leaves their meaning
 * open; agy's `inputTokens` leaves out cache reads, and its `outputTokens`
 * holds the thought tokens.
 */
const promptUsageSchema = z.looseObject({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  thoughtTokens: z.number().nonnegative().nullish(),
  cachedReadTokens: z.number().nonnegative().nullish(),
  cachedWriteTokens: z.number().nonnegative().nullish(),
})
export type AcpPromptUsage = z.infer<typeof promptUsageSchema>

export const promptResultSchema = z.looseObject({ stopReason: z.enum(STOP_REASONS), usage: promptUsageSchema.nullish().catch(null) })

export const TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const
export type AcpToolKind = (typeof TOOL_KINDS)[number]
const toolKindSchema = z.enum(TOOL_KINDS).catch('other')
const toolStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed'])

const toolCallContentSchema = z.union([
  z.looseObject({ type: z.literal('content'), content: contentBlockSchema }),
  z.looseObject({ type: z.literal('diff'), path: z.string(), oldText: z.string().nullish(), newText: z.string() }),
  z.looseObject({ type: z.literal('terminal'), terminalId: z.string() }),
])
export type AcpToolCallContent = z.infer<typeof toolCallContentSchema>

/** A tool call as `tool_call` starts it and `tool_call_update` changes it: every field but the id may be absent from an update. */
const toolCallFieldsSchema = z.looseObject({
  toolCallId: z.string(),
  title: z.string().nullish(),
  kind: toolKindSchema.nullish(),
  status: toolStatusSchema.nullish(),
  content: z.array(toolCallContentSchema).nullish(),
  locations: z.array(z.looseObject({ path: z.string(), line: z.number().nullish() })).nullish(),
  rawInput: z.json().optional(),
  rawOutput: z.json().optional(),
  _meta: z.json().optional(),
})
export type AcpToolCall = z.infer<typeof toolCallFieldsSchema>

export const sessionUpdateSchema = z.discriminatedUnion('sessionUpdate', [
  z.looseObject({ sessionUpdate: z.literal('agent_message_chunk'), content: contentBlockSchema }),
  z.looseObject({ sessionUpdate: z.literal('agent_thought_chunk'), content: contentBlockSchema }),
  z.looseObject({ sessionUpdate: z.literal('user_message_chunk'), content: contentBlockSchema }),
  toolCallFieldsSchema.extend({ sessionUpdate: z.literal('tool_call') }),
  toolCallFieldsSchema.extend({ sessionUpdate: z.literal('tool_call_update') }),
  z.looseObject({
    sessionUpdate: z.literal('plan'),
    entries: z.array(z.looseObject({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']).catch('pending') })),
  }),
  z.looseObject({ sessionUpdate: z.literal('usage_update'), used: z.number(), size: z.number() }),
  z.looseObject({
    sessionUpdate: z.literal('available_commands_update'),
    availableCommands: z.array(z.looseObject({
      name: z.string().min(1),
      description: z.string().catch(''),
      input: z.looseObject({ hint: z.string().optional() }).nullish().catch(null),
    })).catch([]),
  }),
  z.looseObject({ sessionUpdate: z.literal('current_mode_update') }),
  z.looseObject({ sessionUpdate: z.literal('config_option_update') }),
  z.looseObject({ sessionUpdate: z.literal('session_info_update') }),
])
export type AcpSessionUpdate = z.infer<typeof sessionUpdateSchema>

export const sessionNotificationSchema = z.looseObject({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
})

export const PERMISSION_OPTION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const
export const requestPermissionSchema = z.looseObject({
  sessionId: z.string(),
  toolCall: toolCallFieldsSchema,
  options: z.array(z.looseObject({ optionId: z.string(), name: z.string(), kind: z.enum(PERMISSION_OPTION_KINDS) })),
})
export type AcpPermissionRequest = z.infer<typeof requestPermissionSchema>

/** `elicitation/create`: a form for the person in one session. The form's schema is read by the MCP form rules. */
export const elicitationRequestSchema = z.looseObject({
  sessionId: z.string(),
  mode: z.string(),
  message: z.string().optional(),
})

export const readTextFileSchema = z.looseObject({
  sessionId: z.string(),
  path: z.string(),
  line: z.number().int().positive().nullish(),
  limit: z.number().int().positive().nullish(),
})
