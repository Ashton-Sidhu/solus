import { bigint, defineTable, text } from '../db/schema/define-table'

/**
 * The sharing domain's tables, declared once for both engines
 * (docs/plans/cloud-service-model.md; docs/plans/multiplayer-sharing.md §3.4).
 * The owner of each resource and its share list; nothing else joins them.
 * The hand-made SQLite tables carried CHECK constraints on the enumerations;
 * the row schemas in `share-manager.ts` validate those on read instead, which
 * is the one form both engines and the builder share.
 */

const ORGANIZATION = text({ notNull: true, default: 'local' })

export const resourceOwner = defineTable('resource_owner', {
  resource_kind: text({ notNull: true }),
  resource_id: text({ notNull: true }),
  owner_user_id: text({ notNull: true }),
  created_at: bigint({ notNull: true }),
  organization_id: ORGANIZATION,
}, {
  primaryKey: ['resource_kind', 'resource_id'],
})

export const shareGrant = defineTable('share_grant', {
  id: text({ primaryKey: true }),
  resource_kind: text({ notNull: true }),
  resource_id: text({ notNull: true }),
  subject_kind: text({ notNull: true }),
  subject_id: text({ notNull: true, default: '' }),
  role: text({ notNull: true }),
  link_secret_hash: text(),
  /** The secret itself, kept so the link is always at hand; null on a row made before the column existed. */
  link_secret: text(),
  granted_by_user_id: text({ notNull: true }),
  created_at: bigint({ notNull: true }),
  organization_id: ORGANIZATION,
}, {
  indexes: [
    { name: 'share_grant_subject', columns: ['resource_kind', 'resource_id', 'subject_kind', 'subject_id'], unique: true },
    { name: 'share_grant_resource_idx', columns: ['resource_kind', 'resource_id'] },
    { name: 'share_grant_secret_idx', columns: ['link_secret_hash'], where: 'link_secret_hash IS NOT NULL' },
  ],
})

export const SHARING_TABLES = [resourceOwner, shareGrant]
