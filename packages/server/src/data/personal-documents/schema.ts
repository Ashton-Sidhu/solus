import { bigint, defineTable, integer, json, text } from '../../db/schema/define-table'

/**
 * The personal documents this host keeps for each person who uses it
 * (docs/adr/0007-personal-settings-source.md, docs/plans/personal-settings-source.md):
 * their settings, and their agent profile while they are signed out. A host is
 * the home of each person who uses it, so `organization_id` is `local`, as for a
 * person's history. `person_key` is the person (`ownerKeyOf`).
 */
export const personalDocuments = defineTable('personal_documents', {
  organization_id: text({ notNull: true, default: 'local' }),
  person_key: text({ notNull: true }),
  /** `settings` or `agent-profile` (`PersonalDocumentKind`). */
  kind: text({ notNull: true }),
  /** The document as JSON: only the keys this host knew when it wrote the row. */
  content: json({ notNull: true, default: '{}' }),
  /** `host`: the person wrote it through a client of this host. `account`: the host pulled it from their account. */
  source: text({ notNull: true }),
  /** The account revision of a copy from the account; null for a copy the host keeps. */
  account_revision: integer(),
  /** Epoch milliseconds of the last change on this host. */
  updated_at: bigint({ notNull: true }),
}, {
  primaryKey: ['organization_id', 'person_key', 'kind'],
})

export const PERSONAL_DOCUMENT_TABLES = [personalDocuments]
