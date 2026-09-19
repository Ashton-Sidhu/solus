import { bigint, defineTable, integer, json, text } from '../db/schema/define-table'

/**
 * The works domain's tables, declared once for both engines
 * (docs/plans/cloud-service-model.md). Every work is a database row (decision
 * D3): the repository-file storage and its manifests are gone. Column names
 * and nullability are the ones the hand-written SQLite migration established,
 * so a host's existing file opens unchanged; `organization_id` is new and
 * `'local'` on a host.
 */

const ORGANIZATION = text({ notNull: true, default: 'local' })

export const works = defineTable('works', {
  id: text({ primaryKey: true }),
  /** Legacy: once `'local'` or `'project'`; always `'local'` now. Kept because
   * a hand-made table declares it NOT NULL with no default, so every insert
   * still fills it. */
  storage: text({ notNull: true, default: 'local' }),
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
})

export const workRevisions = defineTable('work_revisions', {
  work_id: text({ notNull: true, references: { table: works, column: 'id', onDelete: 'cascade' } }),
  rev: integer({ notNull: true }),
  content: text(),
  updated_at: bigint(),
  organization_id: ORGANIZATION,
}, {
  primaryKey: ['work_id', 'rev'],
})

export const workAnnotations = defineTable('work_annotations', {
  work_id: text({ primaryKey: true }),
  data: json(),
  updated_at: bigint(),
  organization_id: ORGANIZATION,
})

export const WORK_TABLES = [works, workRevisions, workAnnotations]
