import { z } from 'zod'
import { appCallerSchema, appJsonSchemaSchema, appRequestSchema, declaredNameSchema, type AppCaller } from './apps'

// ─── App models ───
//
// A model call is one request of an app's code to a model, kept as a record on
// the host (docs/plans/app-models.md). A mutation or a workflow step starts
// it; the UI watches it by its id; a workflow step can wait for its result.

const jsonSchema = z.json()
type Json = z.infer<typeof jsonSchema>

export const APP_MODEL_CALL_STATES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const
export type AppModelCallState = (typeof APP_MODEL_CALL_STATES)[number]

/** The reasoning effort an app's code asks for. The owner chooses the model; the code knows how hard the task is. */
export const APP_MODEL_EFFORTS = ['low', 'medium', 'high'] as const
export type AppModelEffort = (typeof APP_MODEL_EFFORTS)[number]

export const APP_MODEL_PROMPT_MAX_CHARS = 100_000
/** The data a call sends with its prompt, as JSON. */
export const APP_MODEL_INPUT_MAX_BYTES = 256 * 1024
/** The text a record keeps of what the model wrote. */
export const APP_MODEL_TEXT_MAX_CHARS = 64 * 1024
export const APP_MODEL_MAX_TOOLS = 20
export const APP_MODEL_DEFAULT_TIMEOUT_SECONDS = 300
export const APP_MODEL_MAX_TIMEOUT_SECONDS = 900

/** What an app's code asks for: `ctx.models.start(setting, request)` and `step.model(name, setting, request)`. */
export const appModelRequestSchema = z.object({
  /** The config field of the kind `model` that names the model. */
  setting: declaredNameSchema,
  prompt: z.string().min(1).max(APP_MODEL_PROMPT_MAX_CHARS),
  input: z.json().optional(),
  /** The app's operations the model may call. */
  tools: z.array(declaredNameSchema).max(APP_MODEL_MAX_TOOLS).default([]),
  /** The JSON Schema of the result; the runner made it from the app's zod schema. Without one, the result is the text. */
  output: appJsonSchemaSchema.optional(),
  effort: z.string().transform((effort) => effort.toLowerCase()).pipe(z.enum(APP_MODEL_EFFORTS)).default('low'),
  /** Held to 10 to 900 seconds, as a workflow step's timeout is held to its range. */
  timeoutSeconds: z.number().default(APP_MODEL_DEFAULT_TIMEOUT_SECONDS)
    .transform((seconds) => Math.min(Math.max(Math.round(seconds), 10), APP_MODEL_MAX_TIMEOUT_SECONDS)),
})
export type AppModelRequest = z.infer<typeof appModelRequestSchema>

/** One operation the model called during a call. */
export const appModelStepSchema = z.object({
  tool: z.string(),
  state: z.enum(['running', 'done', 'failed']),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  error: z.string().nullable(),
})
export type AppModelStep = z.infer<typeof appModelStepSchema>

export const appModelUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
})
export type AppModelUsage = z.infer<typeof appModelUsageSchema>

/** One model call as the host keeps it. */
export const appModelCallRecordSchema = z.object({
  id: z.string(),
  appId: z.string(),
  setting: z.string(),
  /** Null until the call starts and the host resolved the setting. */
  provider: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.enum(APP_MODEL_EFFORTS),
  status: z.enum(APP_MODEL_CALL_STATES),
  prompt: z.string(),
  tools: z.array(z.string()),
  text: z.string(),
  steps: z.array(appModelStepSchema),
  result: jsonSchema.nullable(),
  error: z.string().nullable(),
  usage: appModelUsageSchema.nullable(),
  caller: appCallerSchema,
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
})
export type AppModelCallRecord = z.infer<typeof appModelCallRecordSchema>

/**
 * One model call as a UI or the Manage page reads it. `text` is what the
 * model wrote from `textFrom` on, so a watcher reads only what is new;
 * `textLength` is the whole length.
 */
export interface AppModelCallView {
  id: string
  setting: string
  provider: string | null
  model: string | null
  effort: AppModelEffort
  status: AppModelCallState
  prompt: string
  tools: string[]
  text: string
  textFrom: number
  textLength: number
  steps: AppModelStep[]
  result: Json | null
  error: string | null
  usage: AppModelUsage | null
  caller: AppCaller
  createdAt: number
  startedAt: number | null
  endedAt: number | null
}

export function isFinishedModelCall(status: AppModelCallState): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

// ─── Requests ───

export const appModelCallsRequestSchema = appRequestSchema.extend({
  status: z.enum(APP_MODEL_CALL_STATES).optional(),
  limit: z.number().int().min(1).max(500).optional(),
})
export type AppModelCallsRequest = z.infer<typeof appModelCallsRequestSchema>

export const appModelCallRequestSchema = appRequestSchema.extend({ callId: z.string().min(1) })
export type AppModelCallRequest = z.infer<typeof appModelCallRequestSchema>

/** What `@models/get` and `@models/cancel` take from a UI. */
export const appModelCallArgumentsSchema = z.object({ id: z.string().min(1), textFrom: z.number().int().min(0).default(0) })
