/**
 * The host outbox — durable cross-host writes, delivered by clients.
 *
 * A host that must write to a resource it does not own (hosts never talk to
 * each other) records an op addressed to the resource's id and reports success.
 * Any client connected to that host drains its pending ops, resolves each
 * resource to the host that owns it, applies the op there, and acks. The op id
 * is the idempotence key end to end. See ADR-0007.
 */

/** Domains that have registered an applier. Widens as domains join. */
export type OutboxDomain = 'tasks' | 'works'

export interface OutboxOp {
  /** ULID minted at record time; the idempotence key. */
  id: string
  domain: OutboxDomain
  /** The id of the resource the op targets (e.g. a task id). How the draining
   *  client finds the owner host — the op itself never names a host. */
  resourceId: string
  /** Domain verb, e.g. 'comment' | 'set-status'. Payload shape is versioned by
   *  this name. */
  name: string
  payload: unknown
  /** Provenance: the session whose agent recorded the op, when there is one. */
  sessionId?: string
  recordedAt: number
  state: 'pending' | 'failed'
  /** Present when `state === 'failed'`: why the last apply attempt failed. */
  error?: string
}

export interface OutboxApplyResult {
  /** Ids applied by this call or already applied before it (both are safe to ack). */
  applied: string[]
  failed: Array<{
    id: string
    error: string
    /** True when retrying can never succeed (e.g. the resource was deleted).
     *  The draining client reports it back so the recording host dead-letters
     *  the op instead of redelivering forever. */
    permanent: boolean
  }>
}

// ─── Task-domain op payloads ───

export interface TaskCommentOpPayload {
  body: string
  /** Who wrote it, as stored on the comment row (agents record 'agent'). */
  author: string
  originSessionId?: string
}

export interface TaskSetStatusOpPayload {
  status: string
  /** Actor label recorded with the status event (usually the session id). */
  actorLabel?: string
}

// ─── Works-domain op payloads (dispatched sessions only) ───
//
// A dispatched session's works belong to its task's host, not the borrowed
// machine — so `create`/`update` record ops instead of writing locally. Every
// works op carries `taskId`: a `create` op names a work id NO host has yet, so
// the courier resolves the owner through the task instead of probing hosts for
// the work. The op's resourceId is the work id (minted at record time for a
// create), which is also the row id the applier writes — id-keyed idempotence.

export interface WorkCreateOpPayload {
  /** The dispatched session's task — owner resolution and the owner-side link. */
  taskId: string
  title: string
  docType: 'doc' | 'slides' | 'diagram'
  content: string
  agentProvider?: string
  originSessionId?: string
  cwd?: string
}

export interface WorkUpdateOpPayload {
  /** Same role as on create: how the courier finds the owner host. */
  taskId: string
  content: string
  title?: string
}
