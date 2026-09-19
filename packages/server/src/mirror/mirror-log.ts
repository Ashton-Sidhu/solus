import { z } from 'zod'
import { getDb, withTx } from '../db'
import { createLogger } from '../logger'
import { nextDeliverySeq } from '../outbox/outbox-store'
import { cloudOwnedOrganization } from '../outbox/cloud-ownership'

const log = createLogger('main', 'mirror-log')

/**
 * The runner's mirror log (docs/plans/cloud-service-model.md §6): an append-only
 * queue of what this host produced for a mirrored domain, numbered in delivery
 * order, shipped by the runner delivery and truncated on acknowledgement. The
 * producer appends and returns; nothing here waits on the network.
 *
 * A host that is not a runner of any organization appends nothing: there is
 * nowhere to ship to, and a log nobody drains would only grow. A domain that
 * needs its rows kept regardless keeps them in its own store — the transcript
 * files and `metrics.db` are the durable copies on this machine; the log holds
 * only what the cloud has not confirmed.
 */

export const MIRROR_DOMAINS = ['transcripts', 'insights'] as const
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
  /** What the payload is about, for the sink's idempotence: a `sessionId:position`, a span id. */
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

/** Whether this host ships mirrored domains anywhere at all. */
export function mirrorEnabled(): boolean {
  return cloudOwnedOrganization() !== null
}

/**
 * Append items in one transaction, each with its own sequence number. Returns
 * how many were recorded: zero when this host mirrors nowhere.
 */
export function appendMirror(domain: MirrorDomain, items: Array<{ key: string; payload: unknown }>): number {
  if (items.length === 0 || !mirrorEnabled()) return 0
  const now = Date.now()
  withTx(() => {
    const insert = getDb().prepare('INSERT INTO mirror_log(seq, domain, key, payload, recorded_at) VALUES (?, ?, ?, ?, ?)')
    for (const item of items) insert.run(nextDeliverySeq(), domain, item.key, JSON.stringify(item.payload), now)
  })
  emitChanged()
  return items.length
}

/** The queued items in delivery order, oldest first. */
export function listMirror(limit: number): MirrorItem[] {
  const rows = rowSchema.array().parse(getDb().prepare('SELECT seq, domain, key, payload FROM mirror_log ORDER BY seq LIMIT ?').all(limit))
  return rows.map((row) => ({ seq: row.seq, domain: row.domain, key: row.key, payload: z.unknown().parse(JSON.parse(row.payload)) }))
}

/** The service applied everything through `seq`: those rows leave the log. */
export function ackMirrorThrough(seq: number): number {
  const result = getDb().prepare('DELETE FROM mirror_log WHERE seq <= ?').run(seq)
  return Number(result.changes)
}

/** How many items wait; a diagnostic for the status surfaces. */
export function mirrorBacklog(): number {
  const row = z.object({ count: z.number() }).parse(getDb().prepare('SELECT COUNT(*) AS count FROM mirror_log').get())
  return row.count
}
