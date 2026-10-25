import { z } from 'zod'
import { shareResourceSchema, shareRoleSchema } from '@solus/contracts/sharing'
import type { SessionRecordUpsert } from '@solus/contracts/types'
import { activitySchema } from '@solus/contracts/activity'

/**
 * What a host sends its organization's Solus API, and what comes back
 * (docs/plans/simplify-auth-and-sync.md §4.5). One route, `POST /runner/deliver`,
 * under `Authorization: Bearer <the person's delegated token>`:
 *
 *   { hostId, items: [{ seq, kind, payload }] }  →  { lastSeq, failed: [{ seq, error }] }
 *
 * Every item carries the `seq` the host numbered it with, in one sequence for
 * the host; a batch is in ascending order. The API applies a batch in one
 * transaction with one cursor write for the (host, person): it skips what is at
 * or below the cursor, skips and names an item that can never apply (`failed`),
 * and stops at an item that may apply later. `lastSeq` is the cursor after the
 * batch; the host drops everything at or below it.
 */

export const RUNNER_DELIVER_PATH = '/runner/deliver'

/** How many items a host sends per request. */
export const RUNNER_BATCH_LIMIT = 100

const seqSchema = z.number().int().positive()

/** The facts of one session record, as a `session` item carries them. */
export const sessionRecordUpsertWireSchema: z.ZodType<SessionRecordUpsert> = z.object({
  sessionId: z.string().min(1),
  provider: z.enum(['claude-code', 'codex', 'opencode']),
  projectPath: z.string(),
  lastActivityAt: z.number(),
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

/**
 * What an item is, and the payload its kind reads:
 * - `session`: the facts of one session record (`SessionRecordUpsert`), coalesced on the host per session.
 * - `transcript`: `{ sessionId, position, message }`, one history row; `{ sessionId, truncateFrom }` when the transcript got shorter.
 * - `activity`: `{ activity }`, one activity row of a mirrored session (plans/012 §5).
 * - `shares`: `{ resource, rows }`, a mirrored session's share list but the owner's row, replaced whole (host-sharing.md §2); sent when it changes.
 * - `insights`: `{ spans: [{ span, events }] }`, every span of one turn, sent once when the turn's root span ends.
 *
 * A write an agent makes (a task, a work, a comment, a link) is not an item: it calls the Solus API directly.
 */
export const DELIVERY_KINDS = ['session', 'transcript', 'activity', 'shares', 'insights'] as const
export const deliveryKindSchema = z.enum(DELIVERY_KINDS)
export type DeliveryKind = z.infer<typeof deliveryKindSchema>

export const runnerDeliverItemSchema = z.object({ seq: seqSchema, kind: deliveryKindSchema, payload: z.unknown() })
/** One item as it arrives; the sink for its kind parses the payload and refuses one that does not read. */
export type RunnerDeliverItem = z.infer<typeof runnerDeliverItemSchema>

export const runnerDeliverRequestSchema = z.object({
  hostId: z.string().min(1),
  items: z.array(runnerDeliverItemSchema).max(RUNNER_BATCH_LIMIT),
})
export type RunnerDeliverRequest = z.infer<typeof runnerDeliverRequestSchema>

export const runnerDeliverResponseSchema = z.object({
  /** The cursor after this batch: every item at or below it is applied or skipped for good. */
  lastSeq: z.number().int().nonnegative(),
  /** The items skipped for good, each with why. */
  failed: z.array(z.object({ seq: seqSchema, error: z.string() })),
})
export type RunnerDeliverResponse = z.infer<typeof runnerDeliverResponseSchema>

export const transcriptMirrorPayloadSchema = z.union([
  z.object({ sessionId: z.string().min(1), position: z.number().int().nonnegative(), message: z.unknown() }),
  z.object({ sessionId: z.string().min(1), truncateFrom: z.number().int().nonnegative() }),
])
export type TranscriptMirrorPayload = z.infer<typeof transcriptMirrorPayloadSchema>

export const activityMirrorPayloadSchema = z.object({ activity: activitySchema })
export type ActivityMirrorPayload = z.infer<typeof activityMirrorPayloadSchema>

/** A host's share rows for one resource, the owner row left out: the API admits a guest and lists members from this copy. The link travels as its hash only. */
export const sharesMirrorPayloadSchema = z.object({
  resource: shareResourceSchema,
  rows: z.array(z.object({
    subjectKind: z.enum(['user', 'team', 'organization', 'everyone']),
    subjectId: z.string(),
    role: shareRoleSchema,
    linkSecretHash: z.string().nullable(),
    grantedByUserId: z.string(),
    createdAt: z.number(),
  })),
})
export type SharesMirrorPayload = z.infer<typeof sharesMirrorPayloadSchema>

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
export const insightsMirrorPayloadSchema = z.object({ spans: z.array(z.object({ span: spanWireSchema, events: z.array(logEventWireSchema) })).min(1) })
export type InsightsMirrorPayload = z.infer<typeof insightsMirrorPayloadSchema>
