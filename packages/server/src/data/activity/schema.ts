import { bigint, defineTable, json, text } from '../../db/schema/define-table'

/**
 * What happened to a session, a task or a work that people read
 * (plans/012-user-actor-and-activity.md §5). Not part of `session_messages`:
 * that table is rebuilt from provider files and would lose these rows.
 *
 * `data` is the whole `ActivityKind`, with `kind` beside it for queries; `by` is
 * the attribution as JSON, with `by_kind` and `by_user_key` beside it so a read
 * can find one person's rows without parsing JSON; `target_user_key` does the
 * same for the person a row is aimed at (a mention, a share).
 */
export const activity = defineTable('activity', {
  id: text({ primaryKey: true }),
  organization_id: text({ notNull: true, default: 'local' }),
  subject_kind: text({ notNull: true }),
  subject_id: text({ notNull: true }),
  at: bigint({ notNull: true }),
  turn_id: text(),
  kind: text({ notNull: true }),
  by_kind: text({ notNull: true }),
  by_user_key: text(),
  /** The person the row is aimed at: who was mentioned, or shared with. */
  target_user_key: text(),
  by: json({ notNull: true }),
  data: json({ notNull: true, default: '{}' }),
}, {
  indexes: [
    { name: 'activity_by_subject', columns: ['subject_kind', 'subject_id', 'at', 'id'] },
    { name: 'activity_for_user', columns: ['target_user_key', 'at', 'id'] },
  ],
})

export const ACTIVITY_TABLES = [activity]
