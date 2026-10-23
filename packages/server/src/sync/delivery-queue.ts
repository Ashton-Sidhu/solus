import { z } from 'zod'
import { getDb, withTx } from '../db'
import { createLogger } from '../logger'
import { hostUserId, isHostUserKey } from '../host/host-user'
import { parseUserKey } from '@solus/contracts/user'
import type { SessionRecordUpsert } from '@solus/contracts/types'
import { deliveryKindSchema, type DeliveryKind } from './runner-protocol'

const log = createLogger('main', 'delivery-queue')

/**
 * The host's one queue to the Solus API (docs/plans/simplify-auth-and-sync.md §4.5).
 * Every row names the organization it goes to and the person whose delegated token
 * carries it, decided by the producer and persisted with the row, so one
 * destination's acknowledgement removes only that destination's rows. Rows are
 * numbered in one sequence for the host (`kv`), which never runs backwards, so a
 * redelivery after a lost acknowledgement is skipped by the API's cursor.
 *
 * The producer appends and returns; nothing here waits on the network. The
 * transcript files and `metrics.db` are the durable copies on this machine; the
 * queue holds only what the API has not confirmed.
 */

/**
 * Where a queued row goes and who delivers it (plans/010-standard-oauth.md): one
 * organization's Solus API, with one person's delegated token. An empty person is the
 * person who linked the host.
 */
export interface DeliveryDestination {
  organizationId: string
  actorUserId: string
}

/** One queued item, as `/runner/deliver` carries it. */
export interface DeliveryItem {
  seq: number
  kind: DeliveryKind
  payload: unknown
}

/** What an append recorded: how many items, and the highest sequence. */
export interface DeliveryAppendResult {
  count: number
  lastSeq: number
}

const rowSchema = z.object({ seq: z.number(), kind: deliveryKindSchema, payload: z.string() })
const destinationRowSchema = z.object({ organization_id: z.string(), actor_user_id: z.string() })

type QueuedListener = () => void
const listeners = new Set<QueuedListener>()

/** Hear every append: how the delivery knows to collect and send. */
export function onDeliveryQueued(listener: QueuedListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function emitQueued(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      log.error('delivery_queued_listener_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

const DELIVERY_SEQ_KEY = 'runner_delivery_seq'
const seqRowSchema = z.object({ value: z.string().nullable() })

/** Reserves `count` consecutive numbers of the host's delivery order and returns the first. Call inside `withTx`. */
function nextDeliverySeq(count = 1): number {
  const row = seqRowSchema.nullish().parse(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(DELIVERY_SEQ_KEY))
  const next = (row?.value ? Number(row.value) : 0) + 1
  getDb().prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(DELIVERY_SEQ_KEY, String(next + count - 1))
  return next
}

/**
 * Who delivers a record's rows: its owner when they are an account, which a
 * delegation names; else '' — the account that linked the host — for the host's
 * own records, whose owner is a host user with no account.
 */
export function deliveryActorOf(ownerKey: string): string {
  const hostUserWithoutAccount = isHostUserKey(ownerKey) && hostUserId()?.kind !== 'account'
  return ownerKey === '' || hostUserWithoutAccount || parseUserKey(ownerKey).kind !== 'account' ? '' : ownerKey
}

/** Appends items of one kind for one destination in one transaction, each with its own sequence number. */
export function appendDelivery(destination: DeliveryDestination, kind: DeliveryKind, items: ReadonlyArray<{ key: string; payload: unknown }>): DeliveryAppendResult {
  if (items.length === 0) return { count: 0, lastSeq: 0 }
  let lastSeq = 0
  withTx(() => {
    const insert = getDb().prepare('INSERT INTO delivery_queue(seq, kind, key, payload, organization_id, actor_user_id) VALUES (?, ?, ?, ?, ?, ?)')
    const firstSeq = nextDeliverySeq(items.length)
    items.forEach((item, index) => {
      lastSeq = firstSeq + index
      insert.run(lastSeq, kind, item.key, JSON.stringify(item.payload), destination.organizationId, destination.actorUserId)
    })
  })
  emitQueued()
  return { count: items.length, lastSeq }
}

/**
 * Queues the facts of one session record. One row per session: new facts merge
 * into the row still queued the way the record store merges them (a field given
 * later wins, a field left out keeps its value, activity never runs backwards),
 * and take a fresh seq, so the queue stays bounded by the number of sessions and
 * an acknowledgement of the older seq cannot drop the newer facts.
 */
export function queueSessionFacts(destination: DeliveryDestination, record: SessionRecordUpsert): number {
  let seq = 0
  withTx(() => {
    const existing = z.object({ seq: z.number(), payload: z.string() }).nullish().parse(
      getDb().prepare("SELECT seq, payload FROM delivery_queue WHERE kind = 'session' AND key = ? AND error IS NULL").get(record.sessionId),
    )
    let merged = record
    if (existing) {
      const queued = z.custom<SessionRecordUpsert>().parse(JSON.parse(existing.payload))
      merged = { ...queued, ...record, lastActivityAt: Math.max(queued.lastActivityAt, record.lastActivityAt) }
      getDb().prepare('DELETE FROM delivery_queue WHERE seq = ?').run(existing.seq)
    }
    seq = nextDeliverySeq()
    getDb().prepare("INSERT INTO delivery_queue(seq, kind, key, payload, organization_id, actor_user_id) VALUES (?, 'session', ?, ?, ?, ?)")
      .run(seq, record.sessionId, JSON.stringify(merged), destination.organizationId, destination.actorUserId)
  })
  emitQueued()
  return seq
}

/** One destination's queued items in delivery order, oldest first; an item the API refused for good is not sent again. */
export function listDelivery(destination: DeliveryDestination, limit: number): DeliveryItem[] {
  const rows = rowSchema.array().parse(getDb().prepare(`
    SELECT seq, kind, payload FROM delivery_queue
    WHERE organization_id = ? AND actor_user_id = ? AND error IS NULL
    ORDER BY seq LIMIT ?
  `).all(destination.organizationId, destination.actorUserId, limit))
  return rows.map((row) => ({ seq: row.seq, kind: row.kind, payload: z.unknown().parse(JSON.parse(row.payload)) }))
}

/**
 * The API's answer to one batch: everything of this destination through `lastSeq`
 * leaves the queue, except an item it refused for good, which stays, named, where
 * the status surfaces count it.
 */
export function ackDelivery(destination: DeliveryDestination, lastSeq: number, failed: ReadonlyArray<{ seq: number; error: string }>): number {
  let acked = 0
  withTx(() => {
    const mark = getDb().prepare('UPDATE delivery_queue SET error = ? WHERE seq = ? AND organization_id = ? AND actor_user_id = ?')
    for (const failure of failed) mark.run(failure.error, failure.seq, destination.organizationId, destination.actorUserId)
    acked = Number(getDb().prepare('DELETE FROM delivery_queue WHERE organization_id = ? AND actor_user_id = ? AND seq <= ? AND error IS NULL')
      .run(destination.organizationId, destination.actorUserId, lastSeq).changes)
  })
  if (failed.length > 0) log.warn('delivery_items_refused', { organizationId: destination.organizationId, seqs: failed.map((failure) => failure.seq) })
  return acked
}

/** Every destination with something to send: what a delivery pass visits. */
export function deliveryDestinations(): DeliveryDestination[] {
  const rows = destinationRowSchema.array().parse(getDb().prepare('SELECT DISTINCT organization_id, actor_user_id FROM delivery_queue WHERE error IS NULL').all())
  return rows.map((row) => ({ organizationId: row.organization_id, actorUserId: row.actor_user_id }))
}

/**
 * A person lost their standing in an organization (plans/010-standard-oauth.md):
 * removal ends everything, so what their work produced and has not been delivered is
 * dropped. Other people's rows in the same organization stay. Answers how many rows went.
 */
export function dropQueuedFor(destination: DeliveryDestination): number {
  return Number(getDb().prepare('DELETE FROM delivery_queue WHERE organization_id = ? AND actor_user_id = ?').run(destination.organizationId, destination.actorUserId).changes)
}

/**
 * What waits to reach each organization's Solus API, for the status surfaces
 * (organization-vms §5): every queued item, and the items the API refused for good.
 */
export function deliveryBacklog(): Array<{ organizationId: string; pending: number; failed: number }> {
  const rows = z.array(z.object({ organization_id: z.string(), pending: z.number(), failed: z.number() })).parse(getDb().prepare(`
    SELECT organization_id, SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN error IS NULL THEN 0 ELSE 1 END) AS failed
    FROM delivery_queue GROUP BY organization_id ORDER BY organization_id
  `).all())
  return rows.map((row) => ({ organizationId: row.organization_id, pending: row.pending, failed: row.failed }))
}
