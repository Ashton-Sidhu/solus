import { bigint, defineTable, integer, json, text } from '../../db/schema/define-table'

/**
 * The works domain's tables, declared once for both engines
 * Work identity and editing projections remain database rows. Body I/O goes
 * through work storage adapters; accepted Artifacts revisions keep only their
 * hash and archive reference here. Column names retain the SQLite contract;
 * `organization_id` is `'local'` on a host.
 */

const ORGANIZATION = text({ notNull: true, default: 'local' })

export const works = defineTable('works', {
  id: text({ primaryKey: true }),
  title: text(),
  preview: text(),
  type: text(),
  session_id: text(),
  agent_provider: text(),
  cwd: text(),
  pinned: integer(),
  content: text(),
  created_at: bigint(),
  updated_at: bigint(),
  meta: json(),
  organization_id: ORGANIZATION,
  /** The body's version (`Work.contentVersion`). A row from before versions starts at 1. */
  content_version: integer({ notNull: true, default: 1 }),
  /** `documentContentHash(content)`. The `work-legacy-removal` migration gave
   * every row from before versions its hash and baseline. */
  content_hash: text({ notNull: true }),
  /** `WorkContentAuthor` JSON; null is a body written before authors were recorded. */
  content_author: json(),
  /** The `rev` the previous-version comparison and revert use: the body the
   * last agent write, upstream pull, or restore displaced. */
  previous_revision_id: integer(),
  /** `WorkLocation` JSON: where a shared work is now (cloud-sharing.md §3a).
   * Null while the work is on this host; a row with a location has no body. */
  location: json(),
  /** The user id of who made the work (plans/029 decision 2): also its owner, never empty, never changed. */
  created_by: text({ notNull: true }),
  /** The position the work's next comment thread takes (`comment_threads.position`), advanced in the inserting transaction. */
  comment_position: integer({ notNull: true, default: 0 }),
  /** `WorkExternalComments` JSON: the linked document's threads and the
   *  operations sent to it (plans/029 §5.2). Never read by a list or a work
   *  row projection; `loadWorkAnnotations` and `work-comments.ts` read it. */
  external_comments: json(),
  /** Advanced by every write of `external_comments`; a refresh that read an older state is refused. */
  external_comments_version: integer({ notNull: true, default: 0 }),
}, {
  indexes: [
    { name: 'works_api_page', columns: ['organization_id', 'created_at', 'id'], descending: ['created_at', 'id'] },
    { name: 'works_api_type_page', columns: ['organization_id', 'type', 'created_at', 'id'], descending: ['created_at', 'id'] },
    { name: 'works_by_session', columns: ['session_id'], where: 'session_id IS NOT NULL' },
  ],
})

export const workRevisions = defineTable('work_revisions', {
  work_id: text({ notNull: true, references: { table: works, column: 'id', onDelete: 'cascade' } }),
  rev: integer({ notNull: true }),
  content: text(),
  /** When the checkpoint was captured. */
  updated_at: bigint(),
  organization_id: ORGANIZATION,
  /** The work's `content_version` for this body; null on a revision from before versions. */
  source_content_version: integer(),
  /** `WorkContentAuthor` JSON; null is an author nobody recorded. */
  author: json(),
  /** `WorkRevisionReason`. A revision from before reasons is a `checkpoint`. */
  reason: text({ notNull: true, default: 'checkpoint' }),
  /** `documentContentHash(content)`, backfilled for revisions from before versions. */
  content_hash: text({ notNull: true }),
}, {
  primaryKey: ['work_id', 'rev'],
})

/**
 * One row per reviewer of a work (docs/plans/work-review-and-live-editing.md,
 * phase 2). The review state and a decision's staleness are derived on read
 * from `decided_content_hash` and the work's current hash; nothing is stored twice.
 */
export const workReviewers = defineTable('work_reviewers', {
  work_id: text({ notNull: true, references: { table: works, column: 'id', onDelete: 'cascade' } }),
  /** `userKey` of the reviewer: an account id, or `guest:<id>`. */
  reviewer_id: text({ notNull: true }),
  display_name: text({ notNull: true }),
  color_index: integer({ notNull: true, default: 0 }),
  /** `User` JSON of who asked; null for a person who reviewed through a link. */
  requested_by: json(),
  requested_at: bigint(),
  request_message: text(),
  /** The `rev` the current request points the reviewer at. */
  requested_rev: integer(),
  /** `WorkReviewDecision`; null until the first decision. */
  decision: text(),
  decision_summary: text(),
  decided_at: bigint(),
  decided_rev: integer(),
  decided_content_hash: text(),
  organization_id: ORGANIZATION,
}, {
  primaryKey: ['work_id', 'reviewer_id'],
  indexes: [
    { name: 'work_reviewers_reviewer', columns: ['reviewer_id', 'requested_at'], descending: ['requested_at'] },
  ],
})

/**
 * The live doc of a work people edit live (docs/plans/work-review-and-live-editing.md,
 * phase 3b): its Yjs state and, in the same row, the last push each client key
 * applied, so a resent push applies once. The host writes it when edits pause
 * and when the room closes; the clients' device copies hold anything newer.
 * `works.content` stays the readable copy the host projects from it.
 */
export const workLiveDocs = defineTable('work_live_docs', {
  work_id: text({ primaryKey: true, references: { table: works, column: 'id', onDelete: 'cascade' } }),
  /** `Y.encodeStateAsUpdate` of the live doc, base64. */
  state: text({ notNull: true }),
  /** `{ [clientKey]: lastSeq }` JSON. */
  client_seqs: json(),
  /** Attribution of the last durably accepted live edit, for restart projection. */
  last_author: json(),
  /** Version this live state was based on; null for a legacy state. */
  body_version: integer(),
  needs_projection: integer({ notNull: true, default: 0 }),
  updated_at: bigint({ notNull: true }),
  organization_id: ORGANIZATION,
})

/** Provider mappings survive a default change and a work deletion until remote cleanup completes. */
export const workStorage = defineTable('work_storage', {
  work_id: text({ primaryKey: true }),
  organization_id: ORGANIZATION,
  provider: text({ notNull: true }),
  repository: text(),
  /** Account/namespace identity; an environment change cannot redirect existing works. */
  storage_scope: text(),
  commit_id: text(),
  generation: integer({ notNull: true, default: 0 }),
  archived_generation: integer({ notNull: true, default: 0 }),
  dirty_since: bigint(),
  due_at: bigint(),
  deleted: integer({ notNull: true, default: 0 }),
  error: text(),
  claim_id: text(),
  claim_until: bigint(),
  operation: json(),
}, { indexes: [{ name: 'work_storage_due', columns: ['provider', 'due_at'], where: 'due_at IS NOT NULL' }] })

/** Immutable bodies are pending here until their Git commit is accepted. */
export const workStorageBodies = defineTable('work_storage_bodies', {
  work_id: text({ notNull: true, references: { table: workStorage, column: 'work_id', onDelete: 'cascade' } }),
  content_hash: text({ notNull: true }),
  content: text(),
  commit_id: text(),
}, { primaryKey: ['work_id', 'content_hash'] })

export const WORK_TABLES = [works, workRevisions, workReviewers, workLiveDocs, workStorage, workStorageBodies]
