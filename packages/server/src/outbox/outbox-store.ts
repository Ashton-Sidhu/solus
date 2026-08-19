import { getDb, withTx } from '../db'
import { ulid } from '../tasks/ulid'
import { createLogger } from '../logger'
import { z } from 'zod'
import type { OutboxApplyResult, OutboxDomain, OutboxOp } from '@solus/contracts/outbox-types'

const log = createLogger('main', 'outbox-store.ts')

/**
 * The host outbox (ADR-0007). This host plays two independent roles through one
 * module: *recorder* (record → list → ack, for writes it cannot deliver) and
 * *owner* (apply, under the idempotence guard, for ops other hosts recorded
 * against resources that live here). Clients ferry ops between the two.
 */

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
 * An op's applier: performs the domain write on the owner host. Runs inside the
 * applied-ops guard, so it executes at most once per op id. Throw
 * `PermanentApplyError` when retrying can never succeed.
 */
export type OutboxApplier = (op: OutboxOp) => Promise<void>

export class PermanentApplyError extends Error {}

const appliers = new Map<OutboxDomain, OutboxApplier>()

/** Register the owner-side write for one domain. Boot-time, once per domain. */
export function registerOutboxApplier(domain: OutboxDomain, applier: OutboxApplier): void {
  appliers.set(domain, applier)
}

/** Record a write this host cannot deliver. Returns the durable op, already
 *  visible to `outboxList` and announced to connected clients. */
export function recordOutboxOp(input: {
  domain: OutboxDomain
  resourceId: string
  name: string
  payload: unknown
  sessionId?: string
}): OutboxOp {
  const now = Date.now()
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
  getDb().prepare(`
    INSERT INTO outbox_ops(id, domain, resource_id, name, payload, session_id, recorded_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(op.id, op.domain, op.resourceId, op.name, JSON.stringify(op.payload), op.sessionId ?? null, now)
  log.info('outbox_op_recorded', { opId: op.id, domain: op.domain, resourceId: op.resourceId, name: op.name })
  emitChanged()
  return op
}

/** Every op still on this host, pending first, in record (id) order. */
export function listOutboxOps(): OutboxOp[] {
  const rows = z.array(outboxOpRowSchema).parse(getDb().prepare(`
    SELECT * FROM outbox_ops ORDER BY id
  `).all())
  return rows.map(opFromRow)
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
      await applier(op)
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
