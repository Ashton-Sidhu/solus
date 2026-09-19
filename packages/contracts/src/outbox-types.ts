/**
 * The host outbox — durable cross-host writes, delivered by clients.
 *
 * A host that must write to a resource it does not own (hosts never talk to
 * each other) records an op addressed to the resource's id and reports success.
 * Any client connected to that host drains its pending ops, resolves each
 * resource to the host that owns it, applies the op there, and acks. The op id
 * is the idempotence key end to end. See ADR-0007.
 */

import type { WorkType } from './types'

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

// ─── Task-domain op payloads a runner delivers to the workspace service ───
//
// On a runner linked to an organization the agent's task writes are cloud-owned
// (docs/plans/cloud-service-model.md §16): `create_task` and `link_task` become
// ops too. The op's resourceId is the task id, minted on the runner before the
// tool answers, so the id the agent holds is the id the service writes.

export interface TaskCreateOpPayload {
  title: string
  projectKey: string | null
  body: string
  kind: 'task' | 'epic'
  parentId: string | null
  priority: string | null
  labels?: string[]
  dueDate: string | null
  status: string
  originSessionId: string | null
  /** The runner's clock at record time: the task's `createdAt`. */
  createdAt: number
}

export interface TaskLinkOpPayload {
  kind: 'work' | 'plan' | 'pr' | 'automation'
  targetScope: string
  targetKey: string
  title?: string
  url?: string
  originSessionId: string | null
  /** Actor label recorded with the link event (usually the session id). */
  actorLabel?: string
}

export interface TaskLinkSessionOpPayload {
  sessionId: string
  role: 'working' | 'referenced'
}

// ─── Works-domain op payloads ───
//
// A dispatched session's works belong to its task's host, not the borrowed
// machine — so `create`/`update` record ops instead of writing locally. Such an
// op carries `taskId`: a `create` op names a work id NO host has yet, so the
// courier resolves the owner through the task instead of probing hosts for the
// work. The op's resourceId is the work id (minted at record time for a
// create), which is also the row id the applier writes — id-keyed idempotence.
//
// A runner linked to an organization records the same ops for the workspace
// service, where the destination is known and `taskId` is absent: the service
// links the work to the session's task itself when `linkToSessionTask` is set.

export interface WorkCreateOpPayload {
  /** The dispatched session's task — owner resolution and the owner-side link. Absent on a cloud-owned op. */
  taskId?: string
  title: string
  docType: WorkType
  content: string
  agentProvider?: string
  originSessionId?: string
  cwd?: string
  /** Cloud-owned ops only: file the work on whatever task `originSessionId` works. */
  linkToSessionTask?: boolean
}

export interface WorkUpdateOpPayload {
  /** Same role as on create: how the courier finds the owner host. Absent on a cloud-owned op. */
  taskId?: string
  content: string
  title?: string
}
