import type { SharedPromptPoll, SharedPromptResult } from '../sharing/shared-prompt'
import { z } from 'zod'
import type { OutboxOp } from '@solus/contracts/outbox-types'
import type { SessionRecordUpsert } from '@solus/contracts/types'
import type { WorkTransfer } from '@solus/contracts/work-transfer'
import { activitySchema } from '@solus/contracts/activity'

/**
 * What a runner sends its organization's workspace service, and what comes
 * back (docs/plans/cloud-service-model.md §16, §6, §5). HTTP routes on the
 * service, all `POST`, all under `Authorization: Bearer <runner grant>`:
 *
 * - `/runner/outbox` — outbox ops of the `tasks` and `works` domains.
 * - `/runner/session-records` — session-record reports.
 * - `/runner/mirror` — mirrored domains (§6): transcript rows, session activity and insights.
 *
 * Every delivered item carries the `seq` the runner numbered it with, in one
 * sequence across every stream; a batch is in ascending order. The service
 * applies in order, skips what it has already applied (`seq` at or below its
 * cursor for that runner and stream), and answers with the last `seq` it
 * applied. A permanent failure is skipped and named so the runner can
 * dead-letter it; a transient one stops the batch there, and the runner sends
 * the rest again.
 */

export const RUNNER_OUTBOX_PATH = '/runner/outbox'
export const RUNNER_SESSION_RECORDS_PATH = '/runner/session-records'
export const RUNNER_MIRROR_PATH = '/runner/mirror'
/** `/runner/works` — a whole work, published on Share or Move (organization-scope §7). */
export const RUNNER_WORKS_PATH = '/runner/works'

/** How many items a runner sends per request. */
export const RUNNER_BATCH_LIMIT = 100

const seqSchema = z.number().int().positive()

export const outboxOpWireSchema: z.ZodType<OutboxOp> = z.object({
  id: z.string().min(1),
  domain: z.enum(['tasks', 'works', 'sessions']),
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
  cwd: z.string().max(4096).nullable().optional(),
  slug: z.string().max(500).nullable().optional(),
  isWorktree: z.boolean().optional(),
  branch: z.string().max(256).nullable().optional(),
  projectRoot: z.string().max(4096).nullable().optional(),
  delegation: z.object({
    messageId: z.string().max(256),
    depth: z.number().int().nonnegative(),
    intent: z.enum(['delegate', 'fire_and_forget']),
    createdAt: z.number(),
  }).nullable().optional(),
  admissionId: z.string().min(1).max(256).optional(),
  privateToOwner: z.boolean().optional(),
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

// ── Mirror (§6) ──────────────────────────────────────────────────────────────

export const mirrorDomainWireSchema = z.enum(['transcripts', 'insights', 'activity'])
export type MirrorDomainWire = z.infer<typeof mirrorDomainWireSchema>

/**
 * One mirrored item. The sink for each domain reads the payload:
 * - `transcripts`: `{ sessionId, position, message }`, one history row at its position;
 *   `{ sessionId, truncateFrom }` when the transcript got shorter (a lineage change).
 * - `insights`: `{ span, events }`, one finished span and the log events it owns.
 * - `activity`: `{ activity }`, one activity row of a mirrored session (plans/012 §5),
 *   its subject named by the id the session's transcript is mirrored under.
 */
export const runnerMirrorItemSchema = z.object({ seq: seqSchema, domain: mirrorDomainWireSchema, key: z.string().min(1), payload: z.unknown() })
/** One item as it arrives; the sink for its domain parses the payload and refuses one that does not read. */
export type RunnerMirrorItem = z.infer<typeof runnerMirrorItemSchema>

export const runnerMirrorRequestSchema = z.object({
  hostId: z.string().min(1),
  items: z.array(runnerMirrorItemSchema).max(RUNNER_BATCH_LIMIT),
})
export type RunnerMirrorRequest = z.infer<typeof runnerMirrorRequestSchema>

export const runnerMirrorResponseSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
})
export type RunnerMirrorResponse = z.infer<typeof runnerMirrorResponseSchema>

export const transcriptMirrorPayloadSchema = z.union([
  z.object({ sessionId: z.string().min(1), position: z.number().int().nonnegative(), message: z.unknown() }),
  z.object({ sessionId: z.string().min(1), truncateFrom: z.number().int().nonnegative() }),
])
export type TranscriptMirrorPayload = z.infer<typeof transcriptMirrorPayloadSchema>

export const activityMirrorPayloadSchema = z.object({ activity: activitySchema })
export type ActivityMirrorPayload = z.infer<typeof activityMirrorPayloadSchema>

const spanWireSchema = z.object({
  spanId: z.string().min(1),
  parentSpanId: z.string().optional(),
  traceId: z.string().min(1),
  kind: z.string().min(1),
  name: z.string(),
  service: z.string().min(1),
  sessionId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  projectRoot: z.string().optional(),
  origin: z.string().optional(),
  userId: z.string().optional(),
  userEmail: z.string().optional(),
  organizationId: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number(),
  status: z.string().min(1),
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})
const logEventWireSchema = z.object({
  eventId: z.number().int(),
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  occurredAt: z.number(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  name: z.string(),
  tag: z.string(),
  file: z.string(),
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})
export const insightsMirrorPayloadSchema = z.object({ span: spanWireSchema, events: z.array(logEventWireSchema) })
export type InsightsMirrorPayload = z.infer<typeof insightsMirrorPayloadSchema>

// ── Publication (organization-scope §7) ──────────────────────────────────────

/**
 * The transfer's outline. It is passed through unparsed, so the fingerprint is
 * computed over what the runner sent; the work domain checks that fingerprint
 * and every body, hash, revision id, and reference on import.
 */
/** Who wrote a body, as an `Attribution`; null where nobody recorded it (plans/012 §2). */
const attributionOutlineSchema = z.object({ kind: z.enum(['user', 'agent', 'automation', 'upstream', 'system']) }).loose().nullable()

const workTransferOutlineSchema = z.object({
  work: z.object({
    id: z.string().min(1),
    content: z.string(),
    title: z.string(),
    type: z.enum(['doc', 'slides', 'diagram', 'artifact']),
    contentVersion: z.number().int().positive(),
    contentHash: z.string().min(1),
    contentAuthor: attributionOutlineSchema,
  }).loose(),
  previousRevisionId: z.number().int().positive().nullable(),
  revisions: z.array(z.object({
    workId: z.string().min(1),
    revisionId: z.number().int().positive(),
    content: z.string(),
    contentHash: z.string().min(1),
    sourceContentVersion: z.number().int().positive().nullable(),
    reason: z.enum(['baseline', 'checkpoint', 'agent', 'upstream', 'review', 'restore']),
    author: attributionOutlineSchema,
    capturedAt: z.string().min(1),
  }).loose()),
  annotations: z.object({ workId: z.string().min(1) }).loose().nullable(),
  fingerprint: z.string().min(1),
})

/**
 * One work, exported whole from the runner (its record, complete history, and
 * comments) for the organization's service to import atomically.
 * `actorUserId` is the account that asked to publish, as the runner admitted
 * them; the service records it as the work's owner and shares the work with
 * the organization like anything made in its space. The same fingerprint sent
 * twice is a retry and answers the stored work.
 */
export const runnerWorkRequestSchema = z.object({
  hostId: z.string().min(1),
  transfer: z.custom<WorkTransfer>((value) => workTransferOutlineSchema.safeParse(value).success),
  actorUserId: z.string().min(1),
})
export type RunnerWorkRequest = z.infer<typeof runnerWorkRequestSchema>

export const runnerWorkResponseSchema = z.object({
  workId: z.string().min(1),
  organizationId: z.string().min(1),
})
export type RunnerWorkResponse = z.infer<typeof runnerWorkResponseSchema>

/** Every body a runner posts to the service; the delivery's one authenticated door takes nothing else. */
export type RunnerRequestBody =
  | SharedPromptPoll
  | SharedPromptResult
  | RunnerOutboxRequest
  | RunnerSessionRecordsRequest
  | RunnerMirrorRequest
  | RunnerWorkRequest
