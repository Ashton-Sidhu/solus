import { bigint, defineTable, json, text } from '../../db/schema/define-table'

/**
 * What happened to a session, a task or a work that people read
 * (plans/012-user-actor-and-activity.md §5). Not part of `session_messages`:
 * that table is rebuilt from provider files and would lose these rows.
 *
 * `data` is the whole `ActivityKind`, with `kind` beside it for queries; `by` is
 * the attribution as JSON, with `by_kind` (user, agent, automation, upstream,
 * system) and `created_by` (the signed-in person the actor acts for, never null:
 * `actingPersonKey`) beside it so a read can find one person's rows without
 * parsing JSON; `user_id` does the same for the person a row is
 * aimed at (a mention, a share).
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
  created_by: text({ notNull: true }),
  /** The person the row is aimed at: who was mentioned, or shared with. */
  user_id: text(),
  by: json({ notNull: true }),
  data: json({ notNull: true, default: '{}' }),
}, {
  indexes: [
    { name: 'activity_by_subject', columns: ['subject_kind', 'subject_id', 'at', 'id'] },
    { name: 'activity_for_user', columns: ['user_id', 'at', 'id'] },
  ],
})

export const ACTIVITY_TABLES = [activity]
