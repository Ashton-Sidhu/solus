import { getDb, withTx } from '../db'
import { ulid } from '../tasks/ulid'
import { createLogger } from '../logger'
import { LOCAL_ORGANIZATION_ID } from '../server/principal'
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
 * (docs/plans/cloud-service-model.md §16): an op whose destination is the
 * workspace service. Those never reach a client courier; the runner's own
 * delivery ships them in sequence order and acks by sequence.
 */

/** Where a recorded op is going: another host through a client courier, or the workspace service through the runner's delivery. */
export type OutboxDestination = 'host' | 'cloud'

const outboxOpRowSchema = z.object({
  id: z.string(),
  domain: z.enum(['tasks', 'works']),
  resource_id: z.string(),
  name: z.string(),
  payload: z.string(),
  session_id: z.string().nullable(),
  recorded_at: z.number(),
  state: z.enum(['pending', 'failed']),
  error: z.string().nullable(),
  seq: z.number().nullable(),
  destination: z.enum(['host', 'cloud']),
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

type OutboxChangedListener = () => void
const changedListeners = new Set<OutboxChangedListener>()

/** Subscribe to any outbox mutation on this host (record, ack, dead-letter). */
export function onOutboxChanged(listener: OutboxChangedListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

function emitChanged(): void {
  for (const listener of changedListeners) {
    try {
      listener()
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

/** The next number in this host's delivery order, shared by every stream the runner ships; durable before the row that carries it. Call inside `withTx`. */
export function nextDeliverySeq(): number {
  const row = seqRowSchema.nullish().parse(getDb().prepare('SELECT value FROM kv WHERE key = ?').get(DELIVERY_SEQ_KEY))
  const next = (row?.value ? Number(row.value) : 0) + 1
  getDb().prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(DELIVERY_SEQ_KEY, String(next))
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
}): OutboxOp {
  const now = Date.now()
  const destination = input.destination ?? 'host'
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
  withTx(() => {
    getDb().prepare(`
      INSERT INTO outbox_ops(id, domain, resource_id, name, payload, session_id, recorded_at, state, seq, destination)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(op.id, op.domain, op.resourceId, op.name, JSON.stringify(op.payload), op.sessionId ?? null, now, nextDeliverySeq(), destination)
  })
  log.info('outbox_op_recorded', { opId: op.id, domain: op.domain, resourceId: op.resourceId, name: op.name, destination })
  emitChanged()
  return op
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

/** The pending cloud-bound ops in delivery order, oldest first. */
export function listCloudOutboxOps(limit: number): SequencedOutboxOp[] {
  const rows = z.array(outboxOpRowSchema).parse(getDb().prepare(`
    SELECT * FROM outbox_ops
    WHERE destination = 'cloud' AND state = 'pending' AND seq IS NOT NULL
    ORDER BY seq
    LIMIT ?
  `).all(limit))
  return rows.map((row) => ({ seq: row.seq ?? 0, op: opFromRow(row) }))
}

/** The workspace service applied everything through `seq`: those ops leave the queue. A dead-lettered one stays, visible. */
export function ackCloudOutboxOpsThrough(seq: number): number {
  const result = getDb().prepare(`
    DELETE FROM outbox_ops WHERE destination = 'cloud' AND state = 'pending' AND seq IS NOT NULL AND seq <= ?
  `).run(seq)
  if (Number(result.changes) > 0) emitChanged()
  return Number(result.changes)
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
  emitChanged()
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
  emitChanged()
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
 * guard row lands after the applier (appliers are async; the sqlite driver is
 * sync), so a crash between the two can re-run one applier on redelivery:
 * appliers must therefore be id-keyed (comments insert under the op id) or
 * convergent (set-status re-applies to the same value).
 */
export async function applyOutboxOps(ops: OutboxOp[]): Promise<OutboxApplyResult> {
  const result: OutboxApplyResult = { applied: [], failed: [] }
  for (const op of ops) {
    const alreadyApplied = getDb().prepare('SELECT 1 FROM applied_ops WHERE op_id = ?').get(op.id)
    if (alreadyApplied) {
      result.applied.push(op.id)
      continue
    }
    const applier = appliers.get(op.domain)
    if (!applier) {
      result.failed.push({ id: op.id, error: `No applier registered for domain "${op.domain}".`, permanent: false })
      continue
    }
    try {
      await applier(op, LOCAL_ORGANIZATION_ID)
      getDb().prepare('INSERT OR IGNORE INTO applied_ops(op_id, resource_id, applied_at) VALUES (?, ?, ?)')
        .run(op.id, op.resourceId, Date.now())
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
})

/** One numbered session-record report of the runner's delivery stream. */
export interface SequencedSessionReport {
  seq: number
  record: SessionRecordUpsert
}

/**
 * Queue a session-record report for the workspace service. One row per session:
 * a report merges into the one still queued the way the record store merges it
 * (a field given later wins, a field left out keeps its value, activity never
 * runs backwards), and takes a fresh seq, so the queue stays bounded by the
 * number of sessions and a later ack cannot drop a newer report.
 */
export function queueSessionReport(record: SessionRecordUpsert): void {
  withTx(() => {
    const existing = sessionReportRowSchema.nullish().parse(
      getDb().prepare('SELECT session_id, seq, payload FROM runner_session_reports WHERE session_id = ?').get(record.sessionId),
    )
    let merged: SessionRecordUpsert = record
    if (existing) {
      const queued: SessionRecordUpsert = z.custom<SessionRecordUpsert>().parse(JSON.parse(existing.payload))
      merged = { ...queued, ...record, lastActivityAt: Math.max(queued.lastActivityAt, record.lastActivityAt) }
    }
    getDb().prepare(`
      INSERT INTO runner_session_reports(session_id, seq, payload) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET seq = excluded.seq, payload = excluded.payload
    `).run(record.sessionId, nextDeliverySeq(), JSON.stringify(merged))
  })
  emitChanged()
}

/** The queued session reports in delivery order, oldest first. */
export function listSessionReports(limit: number): SequencedSessionReport[] {
  const rows = z.array(sessionReportRowSchema).parse(getDb().prepare(`
    SELECT session_id, seq, payload FROM runner_session_reports ORDER BY seq LIMIT ?
  `).all(limit))
  return rows.map((row) => ({ seq: row.seq, record: z.custom<SessionRecordUpsert>().parse(JSON.parse(row.payload)) }))
}

/** The workspace service applied every report through `seq`: those rows leave the queue; a report re-queued since keeps its newer seq and stays. */
export function ackSessionReportsThrough(seq: number): number {
  const result = getDb().prepare('DELETE FROM runner_session_reports WHERE seq <= ?').run(seq)
  return Number(result.changes)
}
