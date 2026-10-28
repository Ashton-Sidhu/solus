import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  webhookActionSchema,
  webhookFilterSchema,
  webhookVerificationFailureSchema,
  webhookVerificationSchema,
  type WebhookAction,
  type WebhookActionResult,
  type WebhookDelivery,
  type WebhookDeliveryOutcome,
  type WebhookDeliverySource,
  type WebhookDeliverySummary,
  type WebhookLastDelivery,
  type WebhookStoredRequest,
  type WebhookVerification,
  type WebhookVerificationFailure,
} from '@solus/contracts/webhooks'
import type { Attribution } from '@solus/contracts/user'
import { getDatabase, type Db } from '../../db/database'
import { attributionJson, parseStoredAttribution, hostAttribution } from '../stored-attribution'
import { webhookDeliveries, webhooks, webhookSeenKeys } from './schema'

/**
 * The webhook records and their deliveries log (docs/plans/webhooks.md §3.3, §5).
 * Plain functions over the ported tables, so the same code runs on SQLite and
 * Postgres. The token and the verification secret are in `webhook-secrets.ts`.
 */

/** Retention (plan §3.3): the last 200 deliveries or 14 days for each webhook, whichever is smaller. */
export const MAX_DELIVERIES_PER_WEBHOOK = 200
export const DELIVERY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

/** A webhook as its row stores it. The views a client reads add the URL mode, the pause by an admin, and the delivery counts. */
export interface WebhookRecord {
  id: string
  organizationId: string
  ownerKey: string
  name: string
  enabled: boolean
  project: string | null
  verification: WebhookVerification
  replayKey: string | null
  actions: WebhookAction[]
  createdBy: Attribution
  copiedUrlHash: string | null
  lostCount: number
  lostAt: number | null
  createdAt: number
  updatedAt: number
}

const flagSchema = z.union([z.boolean(), z.number()]).transform((value) => value === true || value === 1)
const timeSchema = z.coerce.number()
const nullableTimeSchema = z.union([z.null(), z.coerce.number()])

const webhookRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  owner_key: z.string(),
  name: z.string(),
  enabled: flagSchema,
  project: z.string().nullable(),
  verification: z.string(),
  replay_key: z.string().nullable(),
  actions: z.string(),
  created_by: z.string(),
  copied_url_hash: z.string().nullable(),
  lost_count: z.coerce.number(),
  lost_at: nullableTimeSchema,
  created_at: timeSchema,
  updated_at: timeSchema,
})

function recordFromRow(row: z.infer<typeof webhookRowSchema>): WebhookRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    ownerKey: row.owner_key,
    name: row.name,
    enabled: row.enabled,
    project: row.project,
    verification: webhookVerificationSchema.parse(JSON.parse(row.verification)),
    replayKey: row.replay_key,
    actions: z.array(webhookActionSchema).parse(JSON.parse(row.actions)),
    createdBy: parseStoredAttribution(row.created_by) ?? hostAttribution(),
    copiedUrlHash: row.copied_url_hash,
    lostCount: row.lost_count,
    lostAt: row.lost_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function insertWebhook(record: WebhookRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${webhooks} (id, organization_id, owner_key, name, enabled, project, verification, replay_key, actions, created_by, copied_url_hash, lost_count, lost_at, created_at, updated_at)
    VALUES (
      ${record.id}, ${record.organizationId}, ${record.ownerKey}, ${record.name}, ${flag(db, record.enabled)}, ${record.project},
      ${JSON.stringify(record.verification)}, ${record.replayKey}, ${JSON.stringify(record.actions)}, ${attributionJson(record.createdBy)},
      ${record.copiedUrlHash}, ${record.lostCount}, ${record.lostAt}, ${record.createdAt}, ${record.updatedAt}
    )
  `)
}

/** Writes the fields a person may change. The owner, the organization, and the creation time never change. */
export async function saveWebhook(record: WebhookRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    UPDATE ${webhooks} SET
      name = ${record.name},
      enabled = ${flag(db, record.enabled)},
      project = ${record.project},
      verification = ${JSON.stringify(record.verification)},
      replay_key = ${record.replayKey},
      actions = ${JSON.stringify(record.actions)},
      copied_url_hash = ${record.copiedUrlHash},
      updated_at = ${record.updatedAt}
    WHERE id = ${record.id}
  `)
}

function flag(db: Db, value: boolean): boolean | number {
  return db.engine === 'postgres' ? value : value ? 1 : 0
}

export async function loadWebhook(id: string, db: Db = getDatabase()): Promise<WebhookRecord | null> {
  const row = await db.get(sql`SELECT * FROM ${webhooks} WHERE id = ${id}`)
  return row ? recordFromRow(webhookRowSchema.parse(row)) : null
}

/** The webhooks that match `where` (every one without it), newest first. */
export async function listWebhooks(where: SQL = sql`1 = 1`, db: Db = getDatabase()): Promise<WebhookRecord[]> {
  const rows = await db.all(sql`SELECT * FROM ${webhooks} WHERE ${where} ORDER BY created_at DESC, id`)
  return z.array(webhookRowSchema).parse(rows).map(recordFromRow)
}

export async function deleteWebhook(id: string, db: Db = getDatabase()): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.run(sql`DELETE FROM ${webhookDeliveries} WHERE webhook_id = ${id}`)
    await tx.run(sql`DELETE FROM ${webhookSeenKeys} WHERE key LIKE ${`${id}:%`}`)
    const result = await tx.run(sql`DELETE FROM ${webhooks} WHERE id = ${id}`)
    return result.changes > 0
  })
}

/** Adds the forwarder's lost count from one drain (plan §2.3). */
export async function addLostRequests(id: string, count: number, at: number, db: Db = getDatabase()): Promise<boolean> {
  const result = await db.run(sql`UPDATE ${webhooks} SET lost_count = lost_count + ${count}, lost_at = ${at} WHERE id = ${id}`)
  return result.changes > 0
}

// ─── Seen keys (plan §2.5, §3.4) ───

export type SeenKeyKind = 'delivery' | 'replay'

/**
 * Records a key for `ttlMs`. True when it is new; false when the same key is
 * still unexpired. An expired key is taken again.
 */
export async function claimSeenKey(kind: SeenKeyKind, webhookId: string, key: string, ttlMs: number, now: number, db: Db = getDatabase()): Promise<boolean> {
  const result = await db.run(sql`
    INSERT INTO ${webhookSeenKeys} (kind, key, expires_at) VALUES (${kind}, ${`${webhookId}:${key}`}, ${now + ttlMs})
    ON CONFLICT (kind, key) DO UPDATE SET expires_at = excluded.expires_at
    WHERE ${webhookSeenKeys}.expires_at <= ${now}
  `)
  return result.changes > 0
}

/** The one sweeper of expired seen keys. */
export async function sweepSeenKeys(now: number, db: Db = getDatabase()): Promise<number> {
  return (await db.run(sql`DELETE FROM ${webhookSeenKeys} WHERE expires_at <= ${now}`)).changes
}

// ─── Deliveries ───

const deliverySummaryColumns = sql`id, webhook_id, received_at, arrived_at, source, outcome, reason, replay_of`
const deliveryOutcomeSchema = z.enum(['pending', 'ran', 'partial', 'failed', 'filtered', 'duplicate', 'unverified', 'not_allowed', 'paused'])
const deliverySummaryRowSchema = z.object({
  id: z.string(),
  webhook_id: z.string(),
  received_at: timeSchema,
  arrived_at: timeSchema,
  source: z.enum(['direct', 'forwarded', 'held']),
  outcome: deliveryOutcomeSchema,
  reason: z.string().nullable(),
  replay_of: z.string().nullable(),
})
const deliveryRowSchema = deliverySummaryRowSchema.extend({
  request: z.string(),
  verification_failure: z.string().nullable(),
  actions: z.string(),
})

function summaryFromRow(row: z.infer<typeof deliverySummaryRowSchema>): WebhookDeliverySummary {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    receivedAt: row.received_at,
    arrivedAt: row.arrived_at,
    source: row.source,
    outcome: row.outcome,
    reason: row.reason,
    replayOf: row.replay_of,
  }
}

const storedRequestSchema = z.object({
  method: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  query: z.array(z.tuple([z.string(), z.string()])),
  body: z.string(),
  bodyIsBase64: z.boolean(),
})
const actionResultSchema = z.object({
  actionId: z.string(),
  type: z.enum(['start_session', 'send_to_session', 'run_automation']),
  status: z.enum(['skipped', 'matched', 'started', 'queued', 'busy', 'failed']),
  filters: z.array(z.object({ filter: webhookFilterSchema, matched: z.boolean() })),
  prompt: z.string().optional(),
  missing: z.array(z.string()),
  error: z.string().optional(),
  sessionId: z.string().optional(),
  automationRunId: z.string().optional(),
})

export interface NewDelivery {
  id: string
  webhookId: string
  receivedAt: number
  arrivedAt: number
  source: WebhookDeliverySource
  outcome: WebhookDeliveryOutcome
  reason: string | null
  replayOf: string | null
  request: WebhookStoredRequest
  verificationFailure: WebhookVerificationFailure | null
  actions: WebhookActionResult[]
}

/** Logs one delivery and applies retention to its webhook. */
export async function insertDelivery(delivery: NewDelivery, db: Db = getDatabase()): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run(sql`
      INSERT INTO ${webhookDeliveries} (id, webhook_id, received_at, arrived_at, source, outcome, reason, replay_of, request, verification_failure, actions)
      VALUES (
        ${delivery.id}, ${delivery.webhookId}, ${delivery.receivedAt}, ${delivery.arrivedAt}, ${delivery.source}, ${delivery.outcome},
        ${delivery.reason}, ${delivery.replayOf}, ${JSON.stringify(delivery.request)},
        ${delivery.verificationFailure ? JSON.stringify(delivery.verificationFailure) : null}, ${JSON.stringify(delivery.actions)}
      )
    `)
    await pruneDeliveries(delivery.webhookId, delivery.arrivedAt, tx)
  })
}

async function pruneDeliveries(webhookId: string, now: number, db: Db): Promise<void> {
  await db.run(sql`DELETE FROM ${webhookDeliveries} WHERE webhook_id = ${webhookId} AND arrived_at < ${now - DELIVERY_RETENTION_MS}`)
  await db.run(sql`
    DELETE FROM ${webhookDeliveries}
    WHERE webhook_id = ${webhookId} AND id NOT IN (
      SELECT id FROM ${webhookDeliveries} WHERE webhook_id = ${webhookId}
      ORDER BY arrived_at DESC, id DESC
      LIMIT ${MAX_DELIVERIES_PER_WEBHOOK}
    )
  `)
}

/** Records the actions' results and the delivery's outcome once they are known. */
export async function finishDelivery(id: string, outcome: WebhookDeliveryOutcome, reason: string | null, actions: WebhookActionResult[], db: Db = getDatabase()): Promise<void> {
  await db.run(sql`UPDATE ${webhookDeliveries} SET outcome = ${outcome}, reason = ${reason}, actions = ${JSON.stringify(actions)} WHERE id = ${id}`)
}

export async function readDelivery(id: string, db: Db = getDatabase()): Promise<WebhookDelivery | null> {
  const row = await db.get(sql`SELECT * FROM ${webhookDeliveries} WHERE id = ${id}`)
  if (!row) return null
  const parsed = deliveryRowSchema.parse(row)
  return {
    ...summaryFromRow(parsed),
    request: storedRequestSchema.parse(JSON.parse(parsed.request)),
    verificationFailure: parsed.verification_failure ? webhookVerificationFailureSchema.parse(JSON.parse(parsed.verification_failure)) : null,
    actions: z.array(actionResultSchema).parse(JSON.parse(parsed.actions)),
  }
}

export interface DeliveryQuery {
  outcomes?: WebhookDeliveryOutcome[]
  /** Deliveries that arrived before this time: the next page. */
  before?: number
  limit?: number
}

/** A webhook's deliveries, newest first. */
export async function listDeliveries(webhookId: string, query: DeliveryQuery = {}, db: Db = getDatabase()): Promise<WebhookDeliverySummary[]> {
  const outcomes = query.outcomes?.length ? sql`AND outcome IN (${sql.join(query.outcomes.map((outcome) => sql`${outcome}`), sql`, `)})` : sql``
  const before = query.before === undefined ? sql`` : sql`AND arrived_at < ${query.before}`
  const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_DELIVERIES_PER_WEBHOOK)
  const rows = await db.all(sql`
    SELECT ${deliverySummaryColumns} FROM ${webhookDeliveries}
    WHERE webhook_id = ${webhookId} ${outcomes} ${before}
    ORDER BY arrived_at DESC, id DESC
    LIMIT ${limit}
  `)
  return z.array(deliverySummaryRowSchema).parse(rows).map(summaryFromRow)
}

export interface DeliveryStats {
  lastDelivery: WebhookLastDelivery | null
  deliveries24h: number
}

/** The newest delivery and the count of the last 24 hours, for each webhook in `ids`. */
export async function deliveryStats(ids: string[], now: number, db: Db = getDatabase()): Promise<Map<string, DeliveryStats>> {
  const stats = new Map<string, DeliveryStats>()
  for (const id of ids) stats.set(id, { lastDelivery: null, deliveries24h: 0 })
  if (!ids.length) return stats
  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `)
  const counts = z.array(z.object({ webhook_id: z.string(), count: z.coerce.number() })).parse(await db.all(sql`
    SELECT webhook_id, COUNT(*) AS count FROM ${webhookDeliveries}
    WHERE webhook_id IN (${idList}) AND arrived_at >= ${now - 24 * 60 * 60 * 1000}
    GROUP BY webhook_id
  `))
  for (const row of counts) stats.get(row.webhook_id)!.deliveries24h = row.count
  const newest = z.array(z.object({ webhook_id: z.string(), arrived_at: timeSchema, outcome: deliveryOutcomeSchema })).parse(await db.all(sql`
    SELECT d.webhook_id, d.arrived_at, d.outcome FROM ${webhookDeliveries} d
    WHERE d.webhook_id IN (${idList}) AND d.id = (
      SELECT d2.id FROM ${webhookDeliveries} d2 WHERE d2.webhook_id = d.webhook_id ORDER BY d2.arrived_at DESC, d2.id DESC LIMIT 1
    )
  `))
  for (const row of newest) stats.get(row.webhook_id)!.lastDelivery = { at: row.arrived_at, outcome: row.outcome }
  return stats
}
