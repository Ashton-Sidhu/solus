import { bigint, defineTable, json, text } from '../../db/schema/define-table'

/**
 * The notifications hub's one table at each record home (plans/015-notifications-hub.md §4).
 * One row per recipient and source event: `event_id` is the producer's stable
 * identity of one occurrence, so a replayed event writes nothing new.
 * Migration `0004_notifications_hub_v2` removed v1's journal tables and columns.
 */
export const notifications = defineTable('notifications', {
  id: text({ primaryKey: true }),
  organization_id: text({ notNull: true }),
  recipient_key: text({ notNull: true }),
  event_id: text({ notNull: true }),
  activity_id: text(),
  kind: text({ notNull: true }),
  /** `<resource kind>:<id>`, so a producer resolves every row about one resource. */
  resource_key: text({ notNull: true }),
  facts: json({ notNull: true }),
  resource: json({ notNull: true }),
  by: json({ notNull: true }),
  summary: json({ notNull: true }),
  created_at: bigint({ notNull: true }),
  read_at: bigint(),
  archived_at: bigint(),
}, {
  indexes: [
    { name: 'notifications_event', columns: ['organization_id', 'recipient_key', 'event_id'], unique: true },
    // Read newest first; both engines scan this index backwards for that order.
    { name: 'notifications_for_recipient', columns: ['recipient_key', 'created_at', 'id'] },
    { name: 'notifications_by_resource', columns: ['organization_id', 'resource_key'] },
  ],
})

export const NOTIFICATION_TABLES = [notifications]
