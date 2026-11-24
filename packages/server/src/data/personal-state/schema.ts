import { bigint, defineTable, text } from '../../db/schema/define-table'

/**
 * One person's own view of a resource (plans/029-fresh-database-baseline.md
 * §3.4): their settle, archive, snooze, and read boundary of a session; their
 * snooze of a task; and their history, when they last opened a work, an app, a
 * file, or an image (docs/plans/person-state.md). It changes that person's
 * lists, and nobody else's.
 *
 * A session or task row is in the record's home and organization, which acts
 * on it. A history row is in the person's home: `local` on their device host,
 * `person:<accountId>` on the Solus API; its `resource_id` is the record key
 * without its kind (`<workId>`, `<installationId>:<appId>`, `<hostId>:<path>`). The
 * person whose state a row holds is the row's creator, so `created_by`
 * names them. A row with every column null records participation: a person's
 * first prompt leaves one, which puts a session they do not own in their list
 * (`SessionViewer.returnToList`), and it is never cleaned up.
 *
 * The parent is polymorphic, so no foreign key: a session or task delete
 * removes its rows in the same transaction.
 */
export const personalResourceState = defineTable('personal_resource_state', {
  organization_id: text({ notNull: true, default: 'local' }),
  /** `session` or `task`; for history, `work`, `app`, `file`, or `image`. */
  resource_kind: text({ notNull: true }),
  resource_id: text({ notNull: true }),
  /** The person whose state this is. */
  created_by: text({ notNull: true }),
  /** When this person settled the session. */
  settled_at: bigint(),
  /** When this person took the session out of their list. */
  archived_at: bigint(),
  /** The wake time. An expired task snooze stays until the person wakes it. */
  snoozed_until: bigint(),
  snooze_note: text(),
  /** When this person last read the session; null when unread for them. */
  viewed_at: bigint(),
  /** When this person pinned the session; their settle or archive ends it. */
  pinned_at: bigint(),
  pin_order_key: text(),
  active_order_key: text(),
  /** When this person last opened the record; null when it is not in their history. */
  opened_at: bigint(),
}, {
  primaryKey: ['organization_id', 'resource_kind', 'resource_id', 'created_by'],
  indexes: [
    // A person's row for one resource, on a host that reads every organization.
    { name: 'personal_resource_state_by_person', columns: ['created_by', 'resource_kind', 'resource_id'] },
    // A person's snoozes, which keep old sessions in their list and order their task snoozes.
    { name: 'personal_resource_state_snoozed', columns: ['created_by', 'resource_kind', 'snoozed_until'], where: 'snoozed_until IS NOT NULL' },
    // A person's history, newest open first.
    { name: 'personal_resource_state_opened', columns: ['organization_id', 'created_by', 'opened_at'], where: 'opened_at IS NOT NULL' },
  ],
})

export const PERSONAL_STATE_TABLES = [personalResourceState]
