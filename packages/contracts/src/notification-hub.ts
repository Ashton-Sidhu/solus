/**
 * The notifications hub (plans/015-notifications-hub.md): what was addressed to
 * one person at one record home. A notification is a recipient projection, not
 * another activity log: it names its source event, its resource, who acted,
 * and a short summary, and holds the recipient's own read and archive state:
 * two separate facts, neither of which approves, completes, or cancels anything.
 *
 * Delivery preferences and live attention stay in `notification-types.ts`; a
 * toast is not history.
 */

import { z } from 'zod'
import { attributionSchema, type Attribution } from './user'

/** Bumped when a source answers a new shape. A client treats an older source as unsupported, not empty. */
export const NOTIFICATION_HUB_VERSION = 2

export const NOTIFICATION_PAGE_DEFAULT = 50
export const NOTIFICATION_PAGE_MAX = 100
/** A count stops at this many; the hub shows "99+" rather than check every row's access. */
export const NOTIFICATION_COUNT_CAP = 100

// ─── Resources ───

/** A pull request by its code host identity. Never a local checkout path. */
export const notificationPrSchema = z.object({
  host: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().optional(),
})
export type NotificationPr = z.infer<typeof notificationPrSchema>

/**
 * What a notification opens. Portable data only: an id at the source home,
 * never a path, a callback, or a command.
 */
export const notificationResourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('work'), workId: z.string().min(1), revisionId: z.number().int().optional() }),
  z.object({ kind: z.literal('task'), taskId: z.string().min(1) }),
  z.object({ kind: z.literal('pr'), pr: notificationPrSchema }),
  z.object({ kind: z.literal('automation'), automationId: z.string().min(1), runId: z.string().min(1) }),
  z.object({
    kind: z.literal('review_job'),
    job: z.enum(['guide', 'lens']),
    pr: notificationPrSchema,
    /** The saved lens, when the job ran one. */
    lensId: z.string().optional(),
  }),
])
export type NotificationResource = z.infer<typeof notificationResourceSchema>

// ─── Kinds ───

/**
 * What happened, with the bounded facts the row shows. A kind never carries a
 * work body, an automation's output, or a transcript.
 */
export const notificationFactsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('work.review_requested'), message: z.string().max(2000).optional() }),
  z.object({ kind: z.literal('work.review_decided'), decision: z.enum(['approved', 'changes_requested', 'commented']) }),
  z.object({ kind: z.literal('task.assigned') }),
  z.object({ kind: z.literal('pr.assigned') }),
  z.object({ kind: z.literal('pr.review_requested') }),
  z.object({ kind: z.literal('automation.finished'), status: z.enum(['succeeded', 'failed', 'cancelled']) }),
  z.object({ kind: z.literal('review_job.finished'), status: z.enum(['ready', 'failed']), error: z.string().max(500).optional() }),
  z.object({ kind: z.literal('mention'), threadId: z.string().optional() }),
])
export type NotificationFacts = z.infer<typeof notificationFactsSchema>
export type NotificationKind = NotificationFacts['kind']

export const NOTIFICATION_KINDS = [
  'work.review_requested', 'work.review_decided', 'task.assigned', 'pr.assigned', 'pr.review_requested',
  'automation.finished', 'review_job.finished', 'mention',
] as const satisfies readonly NotificationKind[]

/** Kinds a person causes for someone else: their own action never alerts them. */
export const OTHER_PERSON_KINDS: ReadonlySet<NotificationKind> = new Set([
  'work.review_requested', 'work.review_decided', 'task.assigned', 'pr.assigned', 'pr.review_requested', 'mention',
])

export const notificationSummarySchema = z.object({
  title: z.string().max(300),
  detail: z.string().max(500).optional(),
})
export type NotificationSummary = z.infer<typeof notificationSummarySchema>

/**
 * One notification, as its home answers its recipient. Read and archived are the
 * recipient's own server-owned facts. What the item still asks of them (is the
 * review open, is the task still theirs) is the owning domain's answer.
 */
export interface HubNotification {
  id: string
  /** The producer's stable event id; the home keeps one row per recipient and event. */
  eventId: string
  /** The activity row the event also wrote, when it wrote one. */
  activityId?: string
  organizationId: string
  facts: NotificationFacts
  resource: NotificationResource
  by: Attribution
  createdAt: number
  summary: NotificationSummary
  readAt: number | null
  archivedAt: number | null
}

export const hubNotificationSchema: z.ZodType<HubNotification> = z.object({
  id: z.string(),
  eventId: z.string(),
  activityId: z.string().optional(),
  organizationId: z.string(),
  facts: notificationFactsSchema,
  resource: notificationResourceSchema,
  by: attributionSchema,
  createdAt: z.number(),
  summary: notificationSummarySchema,
  readAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
})

// ─── Reads ───

export const notificationViewSchema = z.enum(['unread', 'all', 'archived'])
export type NotificationView = z.infer<typeof notificationViewSchema>

export const notificationFilterSchema = z.object({
  view: notificationViewSchema.default('all'),
  kinds: z.array(z.enum(NOTIFICATION_KINDS)).max(NOTIFICATION_KINDS.length).optional(),
})
export type NotificationFilter = z.infer<typeof notificationFilterSchema>

export const notificationListRequestSchema = z.object({
  filter: notificationFilterSchema.default({ view: 'all' }),
  /** The opaque cursor of the previous page. It is bound to its recipient, home, and filter. */
  cursor: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(NOTIFICATION_PAGE_MAX).default(NOTIFICATION_PAGE_DEFAULT),
})
export type NotificationListRequest = z.input<typeof notificationListRequestSchema>

export interface NotificationPage {
  items: HubNotification[]
  /** The next page's cursor; null at the end. */
  cursor: string | null
}

export interface NotificationCount {
  unread: number
  /** True when the count stopped at `NOTIFICATION_COUNT_CAP`. */
  isCapped: boolean
}

// ─── Writes ───

/** Set, never toggle: a repeated request leaves the same state. */
export const notificationSetReadSchema = z.object({ id: z.string().min(1), read: z.boolean() })
export type NotificationSetRead = z.infer<typeof notificationSetReadSchema>

export const notificationSetArchivedSchema = z.object({ id: z.string().min(1), archived: z.boolean() })
export type NotificationSetArchived = z.infer<typeof notificationSetArchivedSchema>

/** The row as the source holds it after the write, or nothing when the caller has no such row. */
export type NotificationStateResult =
  | { ok: true; notification: HubNotification }
  | { ok: false; reason: 'not_found' }

/** `notifications.changed`: the recipient's feed at this source changed. Read its first page again. */
export type NotificationsChanged = Record<string, never>

/** What a source answers about its hub. */
export interface NotificationHubCapability {
  version: number
}
