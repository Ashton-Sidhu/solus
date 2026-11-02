import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { WEBHOOK_DELIVERY_ID_TTL_MS, WEBHOOK_REPLAY_KEY_TTL_MS } from '@solus/contracts/webhooks'
import { getDatabase, type Db } from '../../db/database'
import { operationReceipts } from './schema'

/**
 * Operation receipts (plans/029-fresh-database-baseline.md §3.6). A receipt
 * claims one durable identity before the write it protects, in the same `Db`
 * transaction as that write, so a rollback removes the claim with the write and
 * a concurrent claimer of the same identity waits on the primary key until the
 * first transaction commits or rolls back.
 *
 * Every namespace is declared here with its scope rule, its duplicate answer,
 * and its replay horizon. A caller never supplies a TTL.
 *
 * | Namespace                            | Scope             | Key                     | Expiry           | Duplicate                                           |
 * | ------------------------------------ | ----------------- | ----------------------- | ---------------- | --------------------------------------------------- |
 * | `api-create-task|work|comment`       | request authority | the retry key           | 24 hours         | same fingerprint: the stored result id, read again  |
 * | `applied-operation`                  | `courier-owner`   | the outbox op id        | none             | the op is applied; the applier must not run         |
 * | `webhook-delivery`, `webhook-replay` | the webhook id    | delivery id, replay key | 25 hours, 7 days | a duplicate delivery; an expired key is taken again |
 *
 * A row whose expiry has passed is replaced by the next claim of its identity;
 * `sweepExpiredReceipts` removes the rest in bounded batches. A receipt with no
 * expiry is never replaced and never swept.
 */

interface ReceiptIdentity {
  scope: string
  namespace: string
  key: string
}

interface ReceiptClaim extends ReceiptIdentity {
  requestHash: string | null
  resultId: string | null
  expiresAt: number | null
}

function identityIs(identity: ReceiptIdentity) {
  return sql`scope = ${identity.scope} AND namespace = ${identity.namespace} AND key = ${identity.key}`
}

/**
 * Inserts the receipt, or replaces one whose expiry has passed (`expires_at <= now`).
 * True when this transaction holds the claim. One statement with RETURNING on
 * both engines, so the decision is the row's and not a read before a write.
 */
async function claim(db: Db, receipt: ReceiptClaim, now: number): Promise<boolean> {
  const rows = await db.all(sql`
    INSERT INTO ${operationReceipts} (scope, namespace, key, request_hash, result_id, expires_at)
    VALUES (${receipt.scope}, ${receipt.namespace}, ${receipt.key}, ${receipt.requestHash}, ${receipt.resultId}, ${receipt.expiresAt})
    ON CONFLICT (scope, namespace, key) DO UPDATE
      SET request_hash = excluded.request_hash, result_id = excluded.result_id, expires_at = excluded.expires_at
      WHERE ${operationReceipts}.expires_at IS NOT NULL AND ${operationReceipts}.expires_at <= ${now}
    RETURNING key
  `)
  return rows.length > 0
}

// ─── API create ───

export type ApiCreateKind = 'task' | 'work' | 'comment'

export const API_CREATE_TTL_MS = 24 * 60 * 60 * 1000

/** The namespace carries the kind, so a task, a work, and a comment created under one authority and retry key never answer each other. */
function apiCreateIdentity(authority: string, kind: ApiCreateKind, retryKey: string): ReceiptIdentity {
  return { scope: authority, namespace: `api-create-${kind}`, key: retryKey }
}

const apiCreateReceiptSchema = z.object({ request_hash: z.string(), result_id: z.string().nullable() })

export type ApiCreateClaim =
  | { outcome: 'claimed' }
  /** The same request completed before: `resultId` is read again under the caller's current authorization. */
  | { outcome: 'duplicate'; resultId: string }
  /** The same request is claimed and not complete. Unreachable after a commit; kept so a half-written row is never answered. */
  | { outcome: 'incomplete' }
  | { outcome: 'different-input' }

/** Claims an API create for `authority`. A duplicate must present the same request fingerprint. */
export async function claimApiCreate(db: Db, authority: string, kind: ApiCreateKind, retryKey: string, requestHash: string, now: number): Promise<ApiCreateClaim> {
  const identity = apiCreateIdentity(authority, kind, retryKey)
  if (await claim(db, { ...identity, requestHash, resultId: null, expiresAt: now + API_CREATE_TTL_MS }, now)) return { outcome: 'claimed' }
  const receipt = apiCreateReceiptSchema.parse(await db.get(sql`SELECT request_hash, result_id FROM ${operationReceipts} WHERE ${identityIs(identity)}`))
  if (receipt.request_hash !== requestHash) return { outcome: 'different-input' }
  return receipt.result_id ? { outcome: 'duplicate', resultId: receipt.result_id } : { outcome: 'incomplete' }
}

/** Records the created resource on its claim, in the transaction that created it. */
export async function completeApiCreate(db: Db, authority: string, kind: ApiCreateKind, retryKey: string, resultId: string): Promise<void> {
  await db.run(sql`UPDATE ${operationReceipts} SET result_id = ${resultId} WHERE ${identityIs(apiCreateIdentity(authority, kind, retryKey))}`)
}

// ─── Applied operation ───

/**
 * The scope is a literal, never the signed-in person: the host's user can change
 * between an apply and its retry, and the op id is globally unique on its own.
 */
const APPLIED_OPERATION = { scope: 'courier-owner', namespace: 'applied-operation' } as const

/** Claims an outbox op on its owner host. False when the op is already applied, so the applier must not run. No expiry: presence means committed. */
export async function claimAppliedOperation(db: Db, opId: string, resourceId: string): Promise<boolean> {
  return claim(db, { ...APPLIED_OPERATION, key: opId, requestHash: null, resultId: resourceId, expiresAt: null }, Date.now())
}

// ─── Webhook ───

export type WebhookReceiptKind = 'delivery' | 'replay'

const WEBHOOK_NAMESPACES = {
  delivery: { namespace: 'webhook-delivery', ttlMs: WEBHOOK_DELIVERY_ID_TTL_MS },
  replay: { namespace: 'webhook-replay', ttlMs: WEBHOOK_REPLAY_KEY_TTL_MS },
} as const

/** Claims a proven delivery id or a rendered replay key for a webhook. False while the same key is unexpired; an expired key is taken again. */
export async function claimWebhookKey(db: Db, webhookId: string, kind: WebhookReceiptKind, key: string, now: number): Promise<boolean> {
  const { namespace, ttlMs } = WEBHOOK_NAMESPACES[kind]
  return claim(db, { scope: webhookId, namespace, key, requestHash: null, resultId: null, expiresAt: now + ttlMs }, now)
}

/** Deletes a webhook's receipts by its scope, both namespaces, when the webhook is deleted. */
export async function deleteWebhookReceipts(db: Db, webhookId: string): Promise<void> {
  await db.run(sql`
    DELETE FROM ${operationReceipts}
    WHERE scope = ${webhookId} AND namespace IN (${WEBHOOK_NAMESPACES.delivery.namespace}, ${WEBHOOK_NAMESPACES.replay.namespace})
  `)
}

// ─── Sweep ───

export const RECEIPT_SWEEP_BATCH = 1000

/**
 * The one sweeper of expired receipts, on the hourly boot timer: at most one
 * batch, oldest expiry first, then the full key for a stable order. A receipt
 * with no expiry is never swept. Returns the rows deleted.
 */
export async function sweepExpiredReceipts(now: number, db: Db = getDatabase()): Promise<number> {
  const result = await db.run(sql`
    DELETE FROM ${operationReceipts} WHERE (scope, namespace, key) IN (
      SELECT scope, namespace, key FROM ${operationReceipts}
      WHERE expires_at IS NOT NULL AND expires_at <= ${now}
      ORDER BY expires_at, scope, namespace, key
      LIMIT ${RECEIPT_SWEEP_BATCH}
    )
  `)
  return result.changes
}
