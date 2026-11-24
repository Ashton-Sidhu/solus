import { bigint, defineTable, json, text } from '../../db/schema/define-table'

/**
 * The codebases this host keeps (docs/plans/codebases.md §5): one row for each
 * codebase, with the full record. The row holds roots only; a host reads the
 * members from its disk. A delete sets `deleted_at` and keeps the row, so the
 * delete moves to each host that has an older copy.
 */
export const codebases = defineTable('codebases', {
  id: text({ primaryKey: true }),
  organization_id: text({ notNull: true, default: 'local' }),
  /** The user id of who saved the first copy on this host. */
  created_by: text({ notNull: true }),
  name: text({ notNull: true }),
  /** `CodebaseRoot[]` as JSON. */
  roots: json({ notNull: true, default: '[]' }),
  /** Epoch milliseconds of the last change, as the writer of the copy set it. The newest copy wins. */
  updated_at: bigint({ notNull: true }),
  /** Set on a deleted codebase. */
  deleted_at: bigint(),
})

export const CODEBASE_TABLES = [codebases]
