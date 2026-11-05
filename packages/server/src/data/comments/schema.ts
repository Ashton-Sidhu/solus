import { bigint, defineTable, integer, json, text } from '../../db/schema/define-table'

/**
 * One comment thread on a task, a work, or a plan
 * (plans/029-fresh-database-baseline.md §5.2; the model validated in
 * plans/data-model-validation/README.md). One row is one thread: its first
 * message is `body`, and its review payload (anchor, replies, read marks,
 * resolution) is `review`. A client never writes the table whole: a write is
 * one thread's command, or a batch checked against the version it was read at.
 *
 * The subject is polymorphic, so no foreign key is possible: a task's or a
 * work's delete, and a task's move, delete its threads in the same transaction
 * (`deleteThreadsOf`). A work's move keeps them; a plan index rebuild never
 * touches them, because a plan's threads belong to its durable annotation
 * identity (`session_id`, `plan_tool_use_id`), not to `indexed_plans`.
 *
 * Ordering: a task's comments read in `(created_at, thread_id)` order; a work's
 * and a plan's in `position`, allocated by advancing the parent row's
 * `comment_position` in the inserting transaction, so two writers never share
 * one position. `version` is the thread's own mutation version, the token of a
 * compare-and-set edit; it says nothing about a work's external comment state,
 * which `works.external_comments_version` guards.
 */

const ORGANIZATION = text({ notNull: true, default: 'local' })

export const commentThreads = defineTable('comment_threads', {
  organization_id: ORGANIZATION,
  /** `task`, `work`, or `plan`. */
  subject_kind: text({ notNull: true }),
  /** The task id, the work id, or the plan's session id. */
  subject_id: text({ notNull: true }),
  /** The plan's `plan_tool_use_id`; `''` on a task or a work. */
  subject_part: text({ notNull: true, default: '' }),
  thread_id: text({ notNull: true }),
  body: text({ notNull: true }),
  /** The user id of who made the thread (plans/029 decision 2): the acting
   *  person, the person an agent acted for, else the host's user. */
  created_by: text({ notNull: true }),
  /** `ThreadAuthor` JSON: the `Attribution` shown for the thread, or the
   *  upstream author's name on an external comment, never a local user. */
  author: json({ notNull: true }),
  /** `local`, or `external` for a comment pulled from an upstream ticket. */
  source: text({ notNull: true, default: 'local' }),
  /** The session whose agent wrote a task comment; null when a person did. */
  origin_session_id: text(),
  created_at: bigint({ notNull: true }),
  updated_at: bigint({ notNull: true }),
  position: integer({ notNull: true }),
  version: integer({ notNull: true, default: 1 }),
  /** A task comment's way upstream: `private` (held here), `pending` (queued
   *  for the linked ticket), `sent` (on the ticket, `external_id` set). A work's
   *  or a plan's thread is always `private`. */
  delivery_state: text({ notNull: true, default: 'private' }),
  /** `<provider>:<external_key>:<ticket id>`: the upstream target an external
   *  id is unique under, so a relinked task cannot collide with the old target's ids. */
  external_scope: text(),
  external_id: text(),
  /** `ThreadReview` JSON: anchor, replies, read marks, and resolution. */
  review: json({ notNull: true, default: '{}' }),
}, {
  primaryKey: ['organization_id', 'subject_kind', 'subject_id', 'subject_part', 'thread_id'],
  indexes: [
    // A work's or a plan's threads in review order (`readThreads`).
    { name: 'comment_threads_position', columns: ['organization_id', 'subject_kind', 'subject_id', 'subject_part', 'position', 'thread_id'] },
    // A task's comments in the order they were written (`readThreads`).
    { name: 'comment_threads_task_order', columns: ['organization_id', 'subject_kind', 'subject_id', 'subject_part', 'created_at', 'thread_id'], where: "subject_kind = 'task'" },
    // The comments queued for a ticket (`pendingThreads`, `hasPendingThreads`).
    { name: 'comment_threads_pending', columns: ['organization_id', 'subject_kind', 'subject_id', 'subject_part', 'created_at', 'thread_id'], where: "delivery_state = 'pending'" },
    // One row per upstream comment under its target; an import of a comment already here is a no-op.
    { name: 'comment_threads_external', columns: ['organization_id', 'subject_kind', 'subject_id', 'subject_part', 'external_scope', 'external_id'], unique: true, where: 'external_id IS NOT NULL' },
  ],
})

export const COMMENT_TABLES = [commentThreads]
