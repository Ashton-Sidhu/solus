import { getDb, withTx } from '../../db'
import { getDatabase } from '../../db/database'
import { ulid } from '@solus/contracts/ulid'
import { createLogger } from '../../logger'
import { LOCAL_ORGANIZATION_ID } from '../../admission/principal'
import { z } from 'zod'
import type { OutboxApplyResult, OutboxDomain, OutboxOp } from '@solus/contracts/outbox-types'
import type { SessionRecordUpsert } from '@solus/contracts/types'

const log = createLogger('main', 'outbox-store.ts')

/**
 * The host outbox (ADR-0007). This host plays two independent roles through one
 * module: *recorder* (record → list → ack, for writes it cannot deliver) and
 * *owner* (apply, under the idempotence guard, for ops other hosts recorded
 * against resources that live here). Clients ferry ops between the two.
 *
 * A runner linked to an organization records a third kind
 * (docs/plans/cloud-service-model.md §16; organization-scope §6): an op whose
 * destination is one organization's Solus API. Those never reach a client
 * courier; the runner's own delivery ships them in sequence order and acks by
 * sequence, per organization, so one organization's receipt never removes
 * another's rows.
 */

/** Where a recorded op is going: another host through a client courier, or the workspace service through the runner's delivery. */
export type OutboxDestination = 'host' | 'cloud'

const outboxOpRowSchema = z.object({
  id: z.string(),
  domain: z.enum(['tasks', 'works', 'sessions']),
  resource_id: z.string(),
  name: z.string(),
  payload: z.string(),
  session_id: z.string().nullable(),
  recorded_at: z.number(),
  state: z.enum(['pending', 'failed']),
  error: z.string().nullable(),
  seq: z.number().nullable(),
  destination: z.enum(['host', 'cloud']),
  organization_id: z.string(),
})

type OutboxOpRow = z.infer<typeof outboxOpRowSchema>

function opFromRow(row: OutboxOpRow): OutboxOp {
  const op: OutboxOp = {
    id: row.id,
    domain: row.domain,
    resourceId: row.resource_id,
    name: row.name,
    payload: z.unknown().parse(JSON.parse(row.payload)),
    recordedAt: row.recorded_at,
    state: row.state,
  }
  if (row.session_id !== null) op.sessionId = row.session_id
  if (row.error !== null) op.error = row.error
  return op
}

export interface OutboxChange {
  /** What `listOutboxOps` returns changed. Only then does a client courier have
   *  anything new to drain; the runner's cloud ops and session reports never
   *  reach one. */
  courierListChanged: boolean
}

type OutboxChangedListener = (change: OutboxChange) => void
const changedListeners = new Set<OutboxChangedListener>()

/** Subscribe to any outbox mutation on this host (record, ack, dead-letter, session report). */
export function onOutboxChanged(listener: OutboxChangedListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

function emitChanged(change: OutboxChange): void {
  for (const listener of changedListeners) {
    try {
      listener(change)
    } catch (error) {
      log.error('outbox_changed_listener_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/**
 * An op's applier: performs the domain write on the owner host, in the
 * organization the caller names (`local` on a host; the runner's on the
 * workspace service). Runs inside the applied-ops guard, so it executes at most
 * once per op id. Throw `PermanentApplyError` when retrying can never succeed.
 */
export type OutboxApplier = (op: OutboxOp, organizationId: string) => Promise<void>

export class PermanentApplyError extends Error {}

const appliers = new Map<OutboxDomain, OutboxApplier>()

/** Register the owner-side write for one domain. Boot-time, once per domain. */
export function registerOutboxApplier(domain: OutboxDomain, applier: OutboxApplier): void {
  appliers.set(domain, applier)
}

const DELIVERY_SEQ_KEY = 'runner_delivery_seq'
const seqRowSchema = z.object({ value: z.string().nullable() })

/** The next number in this host's delivery order, shared by every stream the runner ships; durable before the row that carries it. Call inside `withTx`.
 *  `count` reserves that many consecutive numbers in one counter write and returns the first. */
export function nextDeliverySeq(count = 1): number {
  const row = seqRowSchema.nullish().parse(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(DELIVERY_SEQ_KEY))
  const next = (row?.value ? Number(row.value) : 0) + 1
  getDb().prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(DELIVERY_SEQ_KEY, String(next + count - 1))
  return next
}

/** Record a write this host cannot deliver. Returns the durable op, already
 *  visible to `outboxList` and announced to connected clients. */
export function recordOutboxOp(input: {
  domain: OutboxDomain
  resourceId: string
  name: string
  payload: unknown
  sessionId?: string
  /** Defaults to `host`: a client courier carries it to the owner host. */
  destination?: OutboxDestination
  /** The organization a `cloud` op is delivered to: the source record's canonical organization. */
  organizationId?: string
  /** The person whose delegated token delivers a `cloud` op (plans/010-standard-oauth.md); empty means the host's linker. */
  actorUserId?: string
}): OutboxOp & { seq: number } {
  const now = Date.now()
  const destination = input.destination ?? 'host'
  if (destination === 'cloud' && !input.organizationId) throw new Error('A cloud-bound outbox op names the organization it is delivered to.')
  const organizationId = input.organizationId ?? LOCAL_ORGANIZATION_ID
  const op: OutboxOp = {
    id: ulid(now),
    domain: input.domain,
    resourceId: input.resourceId,
    name: input.name,
    payload: input.payload,
    recordedAt: now,
    state: 'pending',
  }
  if (input.sessionId !== undefined) op.sessionId = input.sessionId
  let seq = 0
  withTx(() => {
    seq = nextDeliverySeq()
    getDb().prepare(`
      INSERT INTO outbox_ops(id, domain, resource_id, name, payload, session_id, recorded_at, state, seq, destination, organization_id, actor_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(op.id, op.domain, op.resourceId, op.name, JSON.stringify(op.payload), op.sessionId ?? null, now, seq, destination, organizationId, input.actorUserId ?? '')
  })
  log.info('outbox_op_recorded', { opId: op.id, domain: op.domain, resourceId: op.resourceId, name: op.name, destination, organizationId })
  emitChanged({ courierListChanged: destination === 'host' })
  return { ...op, seq }
}

/** Every op a client courier may see: host-bound ops in record (id) order, pending
 *  first, plus any dead-lettered cloud op so its failure stays visible. */
export function listOutboxOps(): OutboxOp[] {
  const rows = z.array(outboxOpRowSchema).parse(getDb().prepare(`
    SELECT * FROM outbox_ops WHERE destination = 'host' OR state = 'failed' ORDER BY id
  `).all())
  return rows.map(opFromRow)
}

/** One numbered op of the runner's delivery stream. */
export interface SequencedOutboxOp {
  seq: number
  op: OutboxOp
}

/**
 * Where a queued row goes and who delivers it (plans/010-standard-oauth.md): one
 * organization's Solus API, with one person's delegated token. An empty person is the
 * person who linked the host.
 */
export interface DeliveryDestination {
  organizationId: string
  actorUserId: string
}

const destinationRowSchema = z.object({ organization_id: z.string(), actor_user_id: z.string() })

/** One destination's pending cloud-bound ops in delivery order, oldest first. */
export function listCloudOutboxOps(destination: DeliveryDestination, limit: number): SequencedOutboxOp[] {
  const rows = z.array(outboxOpRowSchema).parse(getDb().prepare(`
    SELECT * FROM outbox_ops
    WHERE destination = 'cloud' AND organization_id = ? AND actor_user_id = ? AND state = 'pending' AND seq IS NOT NULL
    ORDER BY seq
    LIMIT ?
  `).all(destination.organizationId, destination.actorUserId, limit))
  return rows.map((row) => ({ seq: row.seq ?? 0, op: opFromRow(row) }))
}

/** The service applied everything of this destination through `seq`: those ops leave the queue. A dead-lettered one stays, visible. */
export function ackCloudOutboxOpsThrough(destination: DeliveryDestination, seq: number): number {
  const result = getDb().prepare(`
    DELETE FROM outbox_ops WHERE destination = 'cloud' AND organization_id = ? AND actor_user_id = ? AND state = 'pending' AND seq IS NOT NULL AND seq <= ?
  `).run(destination.organizationId, destination.actorUserId, seq)
  if (Number(result.changes) > 0) emitChanged({ courierListChanged: false })
  return Number(result.changes)
}

/** Whether a pending cloud-bound op at or below `seq` is still queued for the organization; a dead-lettered one no longer counts. */
export function cloudOutboxPendingThrough(organizationId: string, seq: number): boolean {
  const row = z.object({ count: z.number() }).parse(getDb().prepare(`
    SELECT COUNT(*) AS count FROM outbox_ops
    WHERE destination = 'cloud' AND organization_id = ? AND state = 'pending' AND seq IS NOT NULL AND seq <= ?
  `).get(organizationId, seq))
  return row.count > 0
}

/** Every destination with a pending cloud-bound op. */
export function cloudOutboxDestinations(): DeliveryDestination[] {
  const rows = z.array(destinationRowSchema).parse(getDb().prepare(`
    SELECT DISTINCT organization_id, actor_user_id FROM outbox_ops WHERE destination = 'cloud' AND state = 'pending'
  `).all())
  return rows.map((row) => ({ organizationId: row.organization_id, actorUserId: row.actor_user_id }))
}

/** Pending ops recorded against one resource — the read-your-writes overlay for
 *  surfaces on the recording host (a failed op no longer describes a write that
 *  will happen, so it is excluded). */
export function pendingOutboxOpsFor(domain: OutboxDomain, resourceId: string): OutboxOp[] {
  const rows = z.array(outboxOpRowSchema).parse(getDb().prepare(`
    SELECT * FROM outbox_ops
    WHERE domain = ? AND resource_id = ? AND state = 'pending'
    ORDER BY id
  `).all(domain, resourceId))
  return rows.map(opFromRow)
}

/** Every pending op in one domain — how a re-shipped task snapshot finds the
 *  works ops that must overlay it (they are keyed by work id, not task id, so
 *  the caller filters by payload). */
export function pendingOutboxOpsForDomain(domain: OutboxDomain): OutboxOp[] {
  const rows = z.array(outboxOpRowSchema).parse(getDb().prepare(`
    SELECT * FROM outbox_ops
    WHERE domain = ? AND state = 'pending'
    ORDER BY id
  `).all(domain))
  return rows.map(opFromRow)
}

/** Delivered (or permanently failed-elsewhere) ops leave the queue. Unknown ids
 *  are a no-op: a lost ack means the client re-acks after redelivery. */
export function ackOutboxOps(opIds: string[]): void {
  if (!opIds.length) return
  withTx(() => {
    const remove = getDb().prepare('DELETE FROM outbox_ops WHERE id = ?')
    for (const opId of opIds) remove.run(opId)
  })
  log.info('outbox_ops_acked', { count: opIds.length })
  emitChanged({ courierListChanged: true })
}

/** Dead-letter ops whose apply can never succeed. They stay listed (visible),
 *  flagged `failed`, and are no longer redelivered by draining clients. */
export function markOutboxOpsFailed(failures: Array<{ id: string; error: string }>): void {
  if (!failures.length) return
  withTx(() => {
    const update = getDb().prepare("UPDATE outbox_ops SET state = 'failed', error = ? WHERE id = ?")
    for (const failure of failures) update.run(failure.error, failure.id)
  })
  log.warn('outbox_ops_dead_lettered', { count: failures.length, opIds: failures.map((f) => f.id) })
  // A dead-lettered op is listed whatever its destination, so its failure stays visible.
  emitChanged({ courierListChanged: true })
}

/**
 * Runs one op's domain write with no guard of its own. The workspace service's
 * runner intake calls this under its sequence cursor, which is the guard there.
 */
export async function applyOutboxOp(op: OutboxOp, organizationId: string): Promise<void> {
  const applier = appliers.get(op.domain)
  if (!applier) throw new Error(`No applier registered for domain "${op.domain}".`)
  await applier(op, organizationId)
}

/**
 * Owner-side apply. An op whose id is already guarded reports `applied` without
 * re-running — that is what makes redelivery and concurrent couriers safe. The
 * guard check, the applier's writes, and the guard row commit in one
 * transaction, so an op either applied and is guarded or did neither: a
 * redelivery never re-runs a committed op, which a versioned write (a work
 * update) would otherwise refuse against its own version advance.
 */
export async function applyOutboxOps(ops: OutboxOp[]): Promise<OutboxApplyResult> {
  const result: OutboxApplyResult = { applied: [], failed: [] }
  for (const op of ops) {
    try {
      await getDatabase().transaction(async () => {
        if (getDb().prepare('SELECT 1 FROM applied_ops WHERE op_id = ?').get(op.id)) return
        const applier = appliers.get(op.domain)
        if (!applier) throw new Error(`No applier registered for domain "${op.domain}".`)
        await applier(op, LOCAL_ORGANIZATION_ID)
        getDb().prepare('INSERT OR IGNORE INTO applied_ops(op_id, resource_id, applied_at) VALUES (?, ?, ?)')
          .run(op.id, op.resourceId, Date.now())
      })
      result.applied.push(op.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const permanent = error instanceof PermanentApplyError
      log.warn('outbox_op_apply_failed', { opId: op.id, domain: op.domain, name: op.name, permanent, error: message })
      result.failed.push({ id: op.id, error: message, permanent })
    }
  }
  return result
}

// ─── The runner's session-record reports ───

const sessionReportRowSchema = z.object({
  session_id: z.string(),
  seq: z.number(),
  payload: z.string(),
  organization_id: z.string(),
})

/** One numbered session-record report of the runner's delivery stream. */
export interface SequencedSessionReport {
  seq: number
  record: SessionRecordUpsert
}

/**
 * Queue a session-record report for its organization's Solus API. One row per
 * session: a report merges into the one still queued the way the record store
 * merges it (a field given later wins, a field left out keeps its value,
 * activity never runs backwards), and takes a fresh seq, so the queue stays
 * bounded by the number of sessions and a later ack cannot drop a newer report.
 * The organization is the session's canonical one, fixed for the session's life.
 * Answers the seq the report took.
 */
export function queueSessionReport(destination: DeliveryDestination, record: SessionRecordUpsert): number {
  let seq = 0
  withTx(() => {
    const existing = sessionReportRowSchema.nullish().parse(
      getDb().prepare('SELECT session_id, seq, payload, organization_id FROM runner_session_reports WHERE session_id = ?').get(record.sessionId),
    )
    let merged: SessionRecordUpsert = record
    if (existing) {
      const queued: SessionRecordUpsert = z.custom<SessionRecordUpsert>().parse(JSON.parse(existing.payload))
      merged = { ...queued, ...record, lastActivityAt: Math.max(queued.lastActivityAt, record.lastActivityAt) }
    }
    seq = nextDeliverySeq()
    getDb().prepare(`
      INSERT INTO runner_session_reports(session_id, seq, payload, organization_id, actor_user_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET seq = excluded.seq, payload = excluded.payload, organization_id = excluded.organization_id, actor_user_id = excluded.actor_user_id
    `).run(record.sessionId, seq, JSON.stringify(merged), destination.organizationId, destination.actorUserId)
  })
  emitChanged({ courierListChanged: false })
  return seq
}

/** One destination's queued session reports in delivery order, oldest first. */
export function listSessionReports(destination: DeliveryDestination, limit: number): SequencedSessionReport[] {
  const rows = z.array(sessionReportRowSchema).parse(getDb().prepare(`
    SELECT session_id, seq, payload, organization_id FROM runner_session_reports WHERE organization_id = ? AND actor_user_id = ? ORDER BY seq LIMIT ?
  `).all(destination.organizationId, destination.actorUserId, limit))
  return rows.map((row) => ({ seq: row.seq, record: z.custom<SessionRecordUpsert>().parse(JSON.parse(row.payload)) }))
}

/** The service applied every report of this destination through `seq`: those rows leave the queue; a report re-queued since keeps its newer seq and stays. */
export function ackSessionReportsThrough(destination: DeliveryDestination, seq: number): number {
  const result = getDb().prepare('DELETE FROM runner_session_reports WHERE organization_id = ? AND actor_user_id = ? AND seq <= ?').run(destination.organizationId, destination.actorUserId, seq)
  return Number(result.changes)
}

/** Every destination with a queued session report. */
export function sessionReportDestinations(): DeliveryDestination[] {
  const rows = z.array(destinationRowSchema).parse(getDb().prepare('SELECT DISTINCT organization_id, actor_user_id FROM runner_session_reports').all())
  return rows.map((row) => ({ organizationId: row.organization_id, actorUserId: row.actor_user_id }))
}

/**
 * A person lost their standing in an organization (plans/010-standard-oauth.md):
 * removal ends everything, so what their work produced and has not been delivered is
 * dropped. Other people's rows in the same organization stay. Answers how many rows went.
 */
export function dropQueuedFor(destination: DeliveryDestination): number {
  let dropped = 0
  withTx(() => {
    const args = [destination.organizationId, destination.actorUserId]
    dropped += Number(getDb().prepare("DELETE FROM outbox_ops WHERE destination = 'cloud' AND organization_id = ? AND actor_user_id = ?").run(...args).changes)
    dropped += Number(getDb().prepare('DELETE FROM runner_session_reports WHERE organization_id = ? AND actor_user_id = ?').run(...args).changes)
    dropped += Number(getDb().prepare('DELETE FROM mirror_log WHERE organization_id = ? AND actor_user_id = ?').run(...args).changes)
  })
  if (dropped > 0) emitChanged({ courierListChanged: false })
  return dropped
}

/** Whether a report at or below `seq` is still queued for the organization. */
export function sessionReportPendingThrough(organizationId: string, seq: number): boolean {
  const row = z.object({ count: z.number() }).parse(getDb().prepare('SELECT COUNT(*) AS count FROM runner_session_reports WHERE organization_id = ? AND seq <= ?').get(organizationId, seq))
  return row.count > 0
}

/** Whether a record's report still waits for its organization's Solus API. */
export function sessionReportQueued(sessionId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM runner_session_reports WHERE session_id = ? LIMIT 1').get(sessionId)
}

/**
 * What waits to reach each organization's Solus API, for the status surfaces
 * (organization-vms §5): every queued outbox operation, session report, and
 * mirror row, and the outbox operations the service refused for good.
 */
export function deliveryBacklog(): Array<{ organizationId: string; pending: number; failed: number }> {
  const rows = z.array(z.object({ organization_id: z.string(), pending: z.number(), failed: z.number() })).parse(getDb().prepare(`
    SELECT organization_id, SUM(pending) AS pending, SUM(failed) AS failed FROM (
      SELECT organization_id, CASE WHEN state = 'pending' THEN 1 ELSE 0 END AS pending, CASE WHEN state = 'failed' THEN 1 ELSE 0 END AS failed
        FROM outbox_ops WHERE destination = 'cloud'
      UNION ALL SELECT organization_id, 1, 0 FROM runner_session_reports
      UNION ALL SELECT organization_id, 1, 0 FROM mirror_log
    ) GROUP BY organization_id ORDER BY organization_id
  `).all())
  return rows.map((row) => ({ organizationId: row.organization_id, pending: row.pending, failed: row.failed }))
}
