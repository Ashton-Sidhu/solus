import { z } from 'zod'
import type { Attribution } from './user'

/**
 * Webhooks (docs/plans/webhooks.md): a record on a host with a secret URL,
 * request checks, and one to ten actions. Other services send a request to its
 * URL, and the host runs the actions that match.
 *
 * The cloud forwarder (`solus-cloud/docs/plans/webhook-forwarder.md`) reads the
 * header names and the outcome values in this file. Change them in both repos.
 */

/** Every receiver answer has this header. An answer with it is final for the forwarder (plan §2.4). */
export const WEBHOOK_OUTCOME_HEADER = 'x-solus-hook-outcome'
/** The forwarder's delivery ID (plan §2.5). The host trusts it only with a valid proof. */
export const WEBHOOK_DELIVERY_ID_HEADER = 'x-solus-hook-delivery-id'
/** When the forwarder received the request, in epoch milliseconds (plan §2.5). */
export const WEBHOOK_RECEIVED_AT_HEADER = 'x-solus-hook-received-at'
/** HMAC-SHA256, with the forwarder secret, of `hostId.webhookId.deliveryId.receivedAt`, in lowercase hex (plan §2.5). */
export const WEBHOOK_PROOF_HEADER = 'x-solus-hook-proof'
/** The receiver route on the host: `/hooks/<webhookId>/<token>`. */
export const WEBHOOK_RECEIVER_PREFIX = '/hooks/'
/** The origin of the cloud forwarder: `https://hooks.solus.sh/<hostId>/<webhookId>/<token>`. */
export const WEBHOOK_CLOUD_ORIGIN = 'https://hooks.solus.sh'

export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024
export const WEBHOOK_MAX_ACTIONS = 10
export const WEBHOOK_MAX_FILTERS = 16
/** Deliveries one webhook accepts in one minute (plan §3.4 step 3). */
export const WEBHOOK_DELIVERIES_PER_MINUTE = 60
/** How long a proven delivery ID is kept (plan §2.5): longer than the 24-hour hold. */
export const WEBHOOK_DELIVERY_ID_TTL_MS = 25 * 60 * 60 * 1000
/** How long a replay key is kept (plan §3.4 step 7). */
export const WEBHOOK_REPLAY_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** A `request_secret` answer works once, for 15 minutes (plan §3.6). */
export const SECRET_REF_TTL_MS = 15 * 60 * 1000

/**
 * The `x-solus-hook-outcome` values. `accepted` and `duplicate` are `202`;
 * the others name the refusal (plan §3.4).
 */
export const webhookAnswerOutcomeSchema = z.enum([
  'accepted',
  'duplicate',
  'not_found',
  'method_not_allowed',
  'too_large',
  'rate_limited',
  'unverified',
  'not_allowed',
  'paused',
])
export type WebhookAnswerOutcome = z.infer<typeof webhookAnswerOutcomeSchema>

// ─── Filters (plan §3.2) ───

export const webhookFilterSchema = z.discriminatedUnion('op', [
  z.object({ path: z.string().min(1), op: z.literal('equals'), value: z.string() }),
  z.object({ path: z.string().min(1), op: z.literal('notEquals'), value: z.string() }),
  z.object({ path: z.string().min(1), op: z.literal('in'), values: z.array(z.string()).min(1) }),
  z.object({ path: z.string().min(1), op: z.literal('exists') }),
])
export type WebhookFilter = z.infer<typeof webhookFilterSchema>

// ─── Verification (plan §3.7) ───

/** Where a value comes from: a header, one `key=value` part of a header, or the bearer token of `Authorization`. */
export const webhookValueSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('header'), name: z.string().min(1) }),
  z.object({ kind: z.literal('header_part'), name: z.string().min(1), key: z.string().min(1), separator: z.enum([',', ';']) }),
  z.object({ kind: z.literal('bearer') }),
])
export type WebhookValueSource = z.infer<typeof webhookValueSourceSchema>

export const webhookSignatureFormatSchema = z.object({
  encoding: z.enum(['hex', 'base64']),
  /** Removed from the value before it is decoded, for example `sha256=`. */
  prefix: z.string().optional(),
  /** One header holds several signatures, split at this text; the check passes if one matches. */
  listSeparator: z.string().min(1).optional(),
})
export type WebhookSignatureFormat = z.infer<typeof webhookSignatureFormatSchema>

/** A sender timestamp: Unix seconds, Unix milliseconds, or an ISO time. */
export const webhookTimestampCheckSchema = z.object({
  source: webhookValueSourceSchema,
  toleranceSeconds: z.number().int().min(1).max(86_400),
})
export type WebhookTimestampCheck = z.infer<typeof webhookTimestampCheckSchema>

const signedCheckFields = {
  /** A template: `{{body}}` is the raw body bytes; `{{headers.name}}` and `{{headers.name|key}}` are header values. */
  signedText: z.string().min(1),
  signature: z.object({ source: webhookValueSourceSchema, format: webhookSignatureFormatSchema }),
  timestamp: webhookTimestampCheckSchema.optional(),
}

/** The stored verification settings. Secrets are never in it; they are in the host's secret store. */
export const webhookVerificationSchema = z.discriminatedUnion('scheme', [
  z.object({ scheme: z.literal('hmac'), algorithm: z.enum(['sha256', 'sha1', 'sha512']), ...signedCheckFields }),
  z.object({ scheme: z.literal('public_key'), algorithm: z.enum(['ed25519', 'ecdsa-p256']), publicKey: z.string().min(1), ...signedCheckFields }),
  z.object({ scheme: z.literal('token'), source: webhookValueSourceSchema }),
  z.object({ scheme: z.literal('jwt'), source: webhookValueSourceSchema, issuer: z.string().min(1), audience: z.string().min(1), jwksUrl: z.url() }),
  z.object({ scheme: z.literal('standard_webhooks') }),
  /** The narrow opt-out (plan §3.7): the sender accepts only a URL. The reason names the sender and why. */
  z.object({ scheme: z.literal('none'), reason: z.string().trim().min(10).max(500) }),
])
export type WebhookVerification = z.infer<typeof webhookVerificationSchema>
export type WebhookVerificationScheme = WebhookVerification['scheme']

/** The schemes that need a shared secret. */
export const SECRET_SCHEMES: readonly WebhookVerificationScheme[] = ['hmac', 'token', 'standard_webhooks']

/**
 * A secret as a person or an agent gives it: the value, or a one-use `secretRef`
 * from `request_secret` (plan §3.6). A `base64` secret is decoded before it is
 * saved; `standard_webhooks` decodes its own `whsec_` secret.
 */
export const webhookSecretInputSchema = z.object({
  secret: z.string().min(1).optional(),
  secretRef: z.string().min(1).optional(),
  secretEncoding: z.enum(['text', 'base64']).optional(),
})
export type WebhookSecretInput = z.infer<typeof webhookSecretInputSchema>

/** Verification settings with their secret, as create and update take them. */
export const webhookVerificationInputSchema = z.intersection(webhookVerificationSchema, webhookSecretInputSchema)
export type WebhookVerificationInput = z.infer<typeof webhookVerificationInputSchema>

/** The step that failed (plan §3.7 Debugging). Never a secret or a computed signature. */
export const webhookVerificationFailureSchema = z.object({
  step: z.enum(['value_missing', 'timestamp_outside_tolerance', 'signature_mismatch', 'jwt_invalid', 'keys_unavailable', 'secret_missing']),
  /** The source name for `value_missing`, the claim for `jwt_invalid`. */
  detail: z.string().optional(),
})
export type WebhookVerificationFailure = z.infer<typeof webhookVerificationFailureSchema>

// ─── Actions (plan §3.1) ───

const actionBase = {
  /** Stable inside one webhook, so a delivery's results name their action. */
  id: z.string().min(1),
  /** A turned-off action does not run (plan §3.3 Pause). */
  enabled: z.boolean(),
  /** Up to 16; all must match. No filters: it runs for every delivery. */
  filters: z.array(webhookFilterSchema).max(WEBHOOK_MAX_FILTERS),
  /** The prompt, with `{{body.path}}`, `{{headers.name}}`, `{{query.name}}`, `{{body}}`, and `{{request}}`. */
  template: z.string(),
}

export const webhookActionSchema = z.discriminatedUnion('type', [
  z.object({
    ...actionBase,
    type: z.literal('start_session'),
    agentProvider: z.enum(['claude-code', 'codex']),
    modelId: z.string().nullable(),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']),
    cwd: z.string().min(1),
    useWorktree: z.boolean().optional(),
  }),
  z.object({ ...actionBase, type: z.literal('send_to_session'), sessionId: z.string().min(1) }),
  z.object({ ...actionBase, type: z.literal('run_automation'), automationId: z.string().min(1) }),
])
export type WebhookAction = z.infer<typeof webhookActionSchema>
export type WebhookActionType = WebhookAction['type']

// ─── The record ───

export type WebhookUrlMode = 'cloud' | 'direct' | 'none'

/** A webhook's URL (plan §5). Only create, rotate, and the owner's read give it, because it holds the token. */
export interface WebhookUrl {
  mode: WebhookUrlMode
  /** `/hooks/<webhookId>/<token>`: the receiver path on the host. */
  path: string
  /** The full URL, or null when the host has no URL (mode `none`). */
  url: string | null
}

/** A summary of the newest delivery, for the list. */
export interface WebhookLastDelivery {
  at: number
  outcome: WebhookDeliveryOutcome
}

export interface Webhook {
  id: string
  organizationId: string
  name: string
  /** The owner's pause is `enabled: false` (plan §5: no separate method). */
  enabled: boolean
  /** An organization admin paused it (plan §2.7). Only an admin can resume it. */
  pausedByAdmin: boolean
  /** The project the webhook belongs to: a host path, for the project panel. */
  project: string | null
  verification: WebhookVerification
  /** A template; a second delivery with the same rendered key is a duplicate. */
  replayKey: string | null
  actions: WebhookAction[]
  /** The URL mode the host gives now. The URL itself is on `WebhookWithUrl`. */
  urlMode: WebhookUrlMode
  /** The URL changed since the owner last copied it (plan §2.2 Link changes). */
  urlChanged: boolean
  /** Requests the forwarder lost while the host was offline, from the drains so far (plan §2.3). */
  lostCount: number
  lostAt: number | null
  lastDelivery: WebhookLastDelivery | null
  /** Deliveries in the last 24 hours. */
  deliveries24h: number
  createdBy: Attribution
  ownerKey: string
  createdAt: number
  updatedAt: number
}

/** A webhook with its URL, for its owner: create, rotate, and `webhookRead`. */
export interface WebhookWithUrl extends Webhook {
  url: WebhookUrl
}

/** What create takes. `organizationId` defaults to the machine's organization. */
export const webhookCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  project: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  verification: webhookVerificationInputSchema,
  replayKey: z.string().min(1).nullable().optional(),
  actions: z.array(webhookActionSchema).min(1).max(WEBHOOK_MAX_ACTIONS),
  organizationId: z.string().min(1).optional(),
})
export type WebhookCreateInput = z.infer<typeof webhookCreateInputSchema>

/** What update takes. A verification without a secret keeps the stored secret when the scheme is the same. */
export const webhookUpdateInputSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  project: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  verification: webhookVerificationInputSchema.optional(),
  replayKey: z.string().min(1).nullable().optional(),
  actions: z.array(webhookActionSchema).min(1).max(WEBHOOK_MAX_ACTIONS).optional(),
  /** The owner copied this URL: the editor stops marking it as changed. */
  copiedUrl: z.string().min(1).optional(),
})
export type WebhookUpdateInput = z.infer<typeof webhookUpdateInputSchema>

// ─── Deliveries (plan §3.3) ───

export type WebhookDeliverySource = 'direct' | 'forwarded' | 'held'

/**
 * - `pending`: the actions are running.
 * - `ran`: every action that matched started or queued.
 * - `partial`: some matched actions failed or were busy.
 * - `failed`: every matched action failed or was busy.
 * - `filtered`: no action matched.
 * - `duplicate`: a proven delivery ID or a replay key was seen before.
 * - `unverified`: verification failed.
 * - `not_allowed`: an organization policy refused an unverified webhook.
 * - `paused`: the owner or an organization admin paused the webhook.
 */
export type WebhookDeliveryOutcome = 'pending' | 'ran' | 'partial' | 'failed' | 'filtered' | 'duplicate' | 'unverified' | 'not_allowed' | 'paused'

/** `matched` is for a dry run only: the action would run. */
export type WebhookActionStatus = 'skipped' | 'matched' | 'started' | 'queued' | 'busy' | 'failed'

export interface WebhookFilterResult {
  filter: WebhookFilter
  matched: boolean
}

export interface WebhookActionResult {
  actionId: string
  type: WebhookActionType
  status: WebhookActionStatus
  filters: WebhookFilterResult[]
  /** The rendered prompt; absent for a skipped action. */
  prompt?: string
  /** Placeholders of the template that had no value. */
  missing: string[]
  error?: string
  sessionId?: string
  automationRunId?: string
}

/** The stored request: redacted headers and query, and the body as text (1 MiB maximum). */
export interface WebhookStoredRequest {
  method: string
  headers: [string, string][]
  query: [string, string][]
  body: string
  /** The body was not valid UTF-8 text; `body` is base64. */
  bodyIsBase64: boolean
}

export interface WebhookDeliverySummary {
  id: string
  webhookId: string
  /** When the sender's request reached Solus: the forwarder's time with a valid proof, else the arrival time. */
  receivedAt: number
  arrivedAt: number
  source: WebhookDeliverySource
  outcome: WebhookDeliveryOutcome
  /** Why nothing ran, in a few words. */
  reason: string | null
  /** The delivery this one replays. */
  replayOf: string | null
}

export interface WebhookDelivery extends WebhookDeliverySummary {
  request: WebhookStoredRequest
  verificationFailure: WebhookVerificationFailure | null
  actions: WebhookActionResult[]
}

/** One dry run (plan §3.3): each action's filter results and rendered prompt. Nothing starts or is stored. */
export interface WebhookDryRunResult {
  /** Present when the sample was checked against the verification settings. */
  verification: { ok: true } | { ok: false; failure: WebhookVerificationFailure } | null
  actions: WebhookActionResult[]
}

export const webhookSampleRequestSchema = z.object({
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z.array(z.tuple([z.string(), z.string()])).default([]),
  query: z.array(z.tuple([z.string(), z.string()])).default([]),
  body: z.string(),
  /** Check verification too: only useful with a real signed request. */
  verify: z.boolean().optional(),
})
export type WebhookSampleRequest = z.input<typeof webhookSampleRequestSchema>

// ─── Host settings (plan §2.3, §4) ───

export interface HostWebhookSettings {
  /** The address where the user exposes this host; the direct URL starts with it. */
  publicUrl: string | null
  /** The forwarder holds requests while this host is offline. Null when the host is not linked. */
  holdWhileOffline: boolean | null
  /** The host is linked to Solus Cloud and the forwarder serves it. */
  linked: boolean
}

export const hostWebhookSettingsPatchSchema = z.object({
  publicUrl: z.url().refine((value) => /^https?:\/\//.test(value), 'Use an http or https URL.').nullable().optional(),
  holdWhileOffline: z.boolean().optional(),
})
export type HostWebhookSettingsPatch = z.infer<typeof hostWebhookSettingsPatchSchema>

// ─── Events ───

export type WebhookChangedEvent =
  | { kind: 'saved'; webhook: Webhook }
  | { kind: 'deleted'; webhookId: string }

/** A short summary only, never the body (plan §5). */
export interface WebhookDeliveryEvent {
  delivery: WebhookDeliverySummary
}

// ─── Organization admins (plan §2.7) ───

export interface WebhookAdminEntry {
  id: string
  organizationId: string
  name: string
  ownerKey: string
  hostId: string
  project: string | null
  urlMode: WebhookUrlMode
  enabled: boolean
  pausedByAdmin: boolean
  verified: boolean
  unverifiedReason: string | null
  actionTypes: WebhookActionType[]
}

