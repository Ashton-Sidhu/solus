import { z } from 'zod'
import type { OutboxOp } from '@solus/contracts/outbox-types'
import type { SessionRecordUpsert } from '@solus/contracts/types'

/**
 * What a runner sends its organization's workspace service, and what comes
 * back (docs/plans/cloud-service-model.md §16). Two HTTP routes on the service,
 * both `POST`, both under `Authorization: Bearer <runner grant>`:
 *
 * - `/runner/outbox` — outbox ops of the `tasks` and `works` domains.
 * - `/runner/session-records` — session-record reports.
 *
 * Every item carries the `seq` the runner numbered it with, in one sequence
 * across both streams; a batch is in ascending order. The service applies in
 * order, skips what it has already applied (`seq` at or below its cursor for
 * that runner and stream), and answers with the last `seq` it applied. A
 * permanent failure is skipped and named so the runner can dead-letter it; a
 * transient one stops the batch there, and the runner sends the rest again.
 */

export const RUNNER_OUTBOX_PATH = '/runner/outbox'
export const RUNNER_SESSION_RECORDS_PATH = '/runner/session-records'

/** How many items a runner sends per request. */
export const RUNNER_BATCH_LIMIT = 100

const seqSchema = z.number().int().positive()

export const outboxOpWireSchema: z.ZodType<OutboxOp> = z.object({
  id: z.string().min(1),
  domain: z.enum(['tasks', 'works']),
  resourceId: z.string().min(1),
  name: z.string().min(1),
  payload: z.unknown(),
  sessionId: z.string().optional(),
  recordedAt: z.number(),
  state: z.enum(['pending', 'failed']),
  error: z.string().optional(),
})

export const runnerOutboxRequestSchema = z.object({
  hostId: z.string().min(1),
  ops: z.array(z.object({ seq: seqSchema, op: outboxOpWireSchema })).max(RUNNER_BATCH_LIMIT),
})
export type RunnerOutboxRequest = z.infer<typeof runnerOutboxRequestSchema>

export const runnerOutboxResponseSchema = z.object({
  /** The highest `seq` applied or skipped so far for this runner's outbox stream. */
  lastSeq: z.number().int().nonnegative(),
  failed: z.array(z.object({ seq: seqSchema, error: z.string(), permanent: z.boolean() })),
})
export type RunnerOutboxResponse = z.infer<typeof runnerOutboxResponseSchema>

const sessionRecordUpsertSchema: z.ZodType<SessionRecordUpsert> = z.object({
  sessionId: z.string().min(1),
  provider: z.enum(['claude-code', 'codex', 'opencode']),
  projectPath: z.string(),
  lastActivityAt: z.number(),
  ownerUserId: z.string().nullable().optional(),
  projectRemote: z.string().nullable().optional(),
  runnerHostId: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  customTitle: z.string().nullable().optional(),
  status: z.enum(['idle', 'running', 'interrupted']).optional(),
  model: z.string().nullable().optional(),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']).nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
  rootSessionId: z.string().nullable().optional(),
  createdAt: z.number().optional(),
  size: z.number().optional(),
})

export const runnerSessionRecordsRequestSchema = z.object({
  hostId: z.string().min(1),
  reports: z.array(z.object({ seq: seqSchema, record: sessionRecordUpsertSchema })).max(RUNNER_BATCH_LIMIT),
})
export type RunnerSessionRecordsRequest = z.infer<typeof runnerSessionRecordsRequestSchema>

export const runnerSessionRecordsResponseSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
})
export type RunnerSessionRecordsResponse = z.infer<typeof runnerSessionRecordsResponseSchema>
