import { z } from 'zod'

/**
 * The organization admin view of webhooks (docs/plans/webhooks.md §2.7): what a host
 * mirrors to its organization's Solus API through its delivery queue, and what
 * `webhookAdminList`, `webhookAdminPause`, and `webhookAdminResume` read and take.
 * Solus Cloud keeps the data and the rules and gives them to the record service as
 * the `webhookAdmin` port of `createSolusApiService` (`WebhookAdminPort`).
 *
 * `solus-cloud` imports this file through `@solus/contracts/webhook-admin`; it keeps no copy.
 * There is no field for a token, a verification secret, a body, headers, or a
 * prompt. The schemas are not strict on purpose: a field this side does not know is
 * dropped.
 */

const id = z.string().min(1).max(128)
const label = z.string().max(200)

/** One organization webhook as its host describes it. `deleted` removes it and its deliveries. */
export const webhookAdminRecordSchema = z.object({
  webhookId: id,
  name: label,
  ownerUserId: id,
  projectName: label.nullable(),
  urlMode: z.enum(['cloud', 'direct', 'none']),
  /** The owner's switch. An admin pause is apart, in Solus Cloud. */
  state: z.enum(['active', 'paused']),
  /** `start_session`, `send_to_session`, `run_automation`, and later types. */
  actionTypes: z.array(z.string().min(1).max(64)).max(10),
  /** Unix time in milliseconds of this version of the metadata on the host. */
  changedAt: z.number().int().nonnegative(),
  deleted: z.boolean().optional(),
})
export type WebhookAdminRecord = z.infer<typeof webhookAdminRecordSchema>

/**
 * A summary of one delivery for the admin view: the time, the outcome, and the status
 * of each action. `WebhookDeliverySummary` is the host's own log summary (`webhooks.ts`),
 * so this one is `WebhookAdminDeliverySummary`.
 */
export const webhookAdminDeliverySummarySchema = z.object({
  webhookId: id,
  deliveryId: id,
  /** Unix time in milliseconds. */
  receivedAt: z.number().int().nonnegative(),
  outcome: z.string().min(1).max(64),
  /** `skipped`, `started`, `queued`, `busy`, `failed`, one for each action. */
  actionStatuses: z.array(z.string().min(1).max(32)).max(10),
})
export type WebhookAdminDeliverySummary = z.infer<typeof webhookAdminDeliverySummarySchema>

/** One `webhooks` item of a host's delivery queue (`runner-protocol.ts`). */
export const webhookAdminMirrorPayloadSchema = z.object({
  webhooks: z.array(webhookAdminRecordSchema).max(500).default([]),
  deliveries: z.array(webhookAdminDeliverySummarySchema).max(500).default([]),
})
export type WebhookAdminMirrorPayload = z.input<typeof webhookAdminMirrorPayloadSchema>

/** What the record service gives Solus Cloud from one host's delivery queue. */
export const webhookAdminIntakeSchema = webhookAdminMirrorPayloadSchema.extend({
  hostId: id,
  organizationId: id,
})
export type WebhookAdminIntake = z.input<typeof webhookAdminIntakeSchema>

/** `webhookAdminPause` and `webhookAdminResume`. */
export const webhookAdminRefSchema = z.object({
  organizationId: id,
  hostId: id,
  webhookId: id,
})
export type WebhookAdminRef = z.infer<typeof webhookAdminRefSchema>

/** One row of `webhookAdminList`. */
export const webhookAdminEntrySchema = z.object({
  hostId: id,
  hostLabel: z.string(),
  webhookId: id,
  name: z.string(),
  ownerUserId: id,
  ownerName: z.string().nullable(),
  projectName: z.string().nullable(),
  urlMode: z.enum(['cloud', 'direct', 'none']),
  state: z.enum(['active', 'paused']),
  actionTypes: z.array(z.string()),
  /** Set while an admin pause stands. */
  adminPause: z.object({ pausedByUserId: z.string().nullable(), pausedAt: z.number().int() }).nullable(),
  lastDelivery: webhookAdminDeliverySummarySchema.omit({ webhookId: true }).nullable(),
  deliveriesLast24Hours: z.number().int().nonnegative(),
})
export type WebhookAdminEntry = z.infer<typeof webhookAdminEntrySchema>

export const webhookAdminListSchema = z.object({
  organizationId: id,
  webhooks: z.array(webhookAdminEntrySchema),
})
export type WebhookAdminList = z.infer<typeof webhookAdminListSchema>

/** Why an admin method refused. */
export type WebhookAdminError = 'not_organization_admin' | 'host_not_of_organization'

export type WebhookAdminOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: WebhookAdminError }

/**
 * What Solus Cloud gives the record service (`createSolusApiService({ webhookAdmin })`).
 * The record service authenticates the caller and the host; the port checks that the
 * caller is an organization admin and that the host delivers to the organization.
 * Every method answers an outcome and never throws for a refusal.
 */
export interface WebhookAdminPort {
  /** From one host's delivery queue: webhook metadata and delivery summaries. */
  intake(input: WebhookAdminIntake): Promise<WebhookAdminOutcome<null>>
  list(input: { readonly userId: string; readonly organizationId: string }): Promise<WebhookAdminOutcome<WebhookAdminList>>
  pause(input: { readonly userId: string } & WebhookAdminRef): Promise<WebhookAdminOutcome<null>>
  resume(input: { readonly userId: string } & WebhookAdminRef): Promise<WebhookAdminOutcome<null>>
}
