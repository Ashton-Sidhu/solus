import { bigint, defineTable, text } from '../db/schema/define-table'

/**
 * The sharing domain's one table, declared once for both engines
 * (docs/plans/access-model.md §2.2; docs/plans/cloud-sharing.md §4c). One row
 * is one ACL entry: what a resource's owner gave to someone else — a person, a
 * team, the organization, or everyone with the link. The owner is never a row
 * here: it is the resource's own `owner_key`. The row schemas in
 * `share-manager.ts` validate the enumerations on read, which is the one form
 * both engines and the builder share.
 */

const ORGANIZATION = text({ notNull: true, default: 'local' })

export const aclEntry = defineTable('acl_entry', {
  id: text({ primaryKey: true }),
  resource_kind: text({ notNull: true }),
  resource_id: text({ notNull: true }),
  subject_kind: text({ notNull: true }),
  subject_id: text({ notNull: true, default: '' }),
  role: text({ notNull: true }),
  link_secret_hash: text(),
  /** The secret itself, kept so the link is always at hand; null on a row made before the column existed. */
  link_secret: text(),
  /** A `custom` row's leaves, as a JSON array; null for a preset (docs/plans/custom-roles.md §5). */
  actions: text(),
  /** When the row stops naming anyone, in ms on this host's clock; null never. Only a link has one. */
  expires_at: bigint(),
  granted_by_user_id: text({ notNull: true }),
  created_at: bigint({ notNull: true }),
  organization_id: ORGANIZATION,
}, {
  indexes: [
    { name: 'acl_entry_subject', columns: ['resource_kind', 'resource_id', 'subject_kind', 'subject_id'], unique: true },
    { name: 'acl_entry_secret_idx', columns: ['link_secret_hash'], where: 'link_secret_hash IS NOT NULL' },
  ],
})

export const SHARING_TABLES = [aclEntry]
