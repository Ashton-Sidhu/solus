import { z } from 'zod'
import { getDb, withTx } from '../../db'
import { createLogger } from '../../logger'
import { nextDeliverySeq, type DeliveryDestination } from '../outbox/outbox-store'

const log = createLogger('main', 'mirror-log')

/**
 * The runner's mirror log (organization-scope §6): an append-only queue of
 * what this host produced for a mirrored domain, numbered in delivery order,
 * shipped by the runner delivery and truncated on acknowledgement. Every row
 * names the organization it goes to, decided by the producer from the source
 * record's canonical organization and persisted with the row, so a deletion or
 * a retry cannot choose another destination, and one organization's
 * acknowledgement removes only that organization's rows. The producer appends
 * and returns; nothing here waits on the network.
 *
 * A domain that needs its rows kept regardless keeps them in its own store —
 * the transcript files and `metrics.db` are the durable copies on this
 * machine; the log holds only what the Solus API has not confirmed.
 */

export const MIRROR_DOMAINS = ['transcripts', 'insights', 'activity'] as const
export type MirrorDomain = (typeof MIRROR_DOMAINS)[number]
export const mirrorDomainSchema = z.enum(MIRROR_DOMAINS)

const rowSchema = z.object({
  seq: z.number(),
  domain: mirrorDomainSchema,
  key: z.string(),
  payload: z.string(),
})

export interface MirrorItem {
  seq: number
  domain: MirrorDomain
  /** What the payload is about, for the sink's idempotence: a `sessionId:position`, a span id, an activity id. */
  key: string
  payload: unknown
}

type MirrorListener = () => void
const listeners = new Set<MirrorListener>()

export function onMirrorChanged(listener: MirrorListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitChanged(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      log.error('mirror_changed_listener_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** What an append recorded: how many items, and the highest sequence, which a publication waits for. */
export interface MirrorAppendResult {
  count: number
  lastSeq: number
}

/**
 * Append items bound for one destination in one transaction, each with its own
 * sequence number.
 */
export function appendMirror(destination: DeliveryDestination, domain: MirrorDomain, items: Array<{ key: string; payload: unknown }>): MirrorAppendResult {
  if (items.length === 0) return { count: 0, lastSeq: 0 }
  let lastSeq = 0
  withTx(() => {
    const insert = getDb().prepare('INSERT INTO mirror_log(seq, domain, key, payload, organization_id, actor_user_id) VALUES (?, ?, ?, ?, ?, ?)')
    const firstSeq = nextDeliverySeq(items.length)
    items.forEach((item, index) => {
      lastSeq = firstSeq + index
      insert.run(lastSeq, domain, item.key, JSON.stringify(item.payload), destination.organizationId, destination.actorUserId)
    })
  })
  emitChanged()
  return { count: items.length, lastSeq }
}

/** One destination's queued items in delivery order, oldest first. */
export function listMirror(destination: DeliveryDestination, limit: number): MirrorItem[] {
  const rows = rowSchema.array().parse(getDb().prepare('SELECT seq, domain, key, payload FROM mirror_log WHERE organization_id = ? AND actor_user_id = ? ORDER BY seq LIMIT ?').all(destination.organizationId, destination.actorUserId, limit))
  return rows.map((row) => ({ seq: row.seq, domain: row.domain, key: row.key, payload: z.unknown().parse(JSON.parse(row.payload)) }))
}

/** The service applied everything of this destination through `seq`: those rows, and only that destination's, leave the log. */
export function ackMirrorThrough(destination: DeliveryDestination, seq: number): number {
  const result = getDb().prepare('DELETE FROM mirror_log WHERE organization_id = ? AND actor_user_id = ? AND seq <= ?').run(destination.organizationId, destination.actorUserId, seq)
  return Number(result.changes)
}

/** Every destination with something queued: what a delivery pass must visit. */
export function mirrorDestinations(): DeliveryDestination[] {
  const rows = z.array(z.object({ organization_id: z.string(), actor_user_id: z.string() })).parse(getDb().prepare('SELECT DISTINCT organization_id, actor_user_id FROM mirror_log').all())
  return rows.map((row) => ({ organizationId: row.organization_id, actorUserId: row.actor_user_id }))
}

/** Whether anything at or below `seq` is still queued for the organization: how a publication learns it has been received. */
export function mirrorPendingThrough(organizationId: string, seq: number): boolean {
  const row = z.object({ count: z.number() }).parse(getDb().prepare('SELECT COUNT(*) AS count FROM mirror_log WHERE organization_id = ? AND seq <= ?').get(organizationId, seq))
  return row.count > 0
}

/** How many items wait; a diagnostic for the status surfaces. */
export function mirrorBacklog(): number {
  const row = z.object({ count: z.number() }).parse(getDb().prepare('SELECT COUNT(*) AS count FROM mirror_log').get())
  return row.count
}
