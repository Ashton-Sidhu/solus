import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { PERSONAL_DOCUMENT_KINDS, type PersonalDocumentKind, type PersonalSettingsSource } from '@solus/contracts/settings'
import { afterDatabaseCommit, getDatabase } from '../../db/database'
import { personalDocuments } from './schema'

/**
 * The rows of `personal_documents`: one document of one person in one home
 * (docs/plans/personal-settings-source.md). The content stays a JSON string here;
 * its owner reads it key by key, so a key that a later version wrote never
 * refuses the row. The person comes from the caller's connection, never from a
 * request.
 */
export interface PersonalDocumentRow {
  personKey: string
  kind: PersonalDocumentKind
  /** The document as JSON. */
  content: string
  source: PersonalSettingsSource
  accountRevision: number | null
  updatedAt: number
}

const rowSchema = z.object({
  person_key: z.string(),
  kind: z.enum(PERSONAL_DOCUMENT_KINDS),
  content: z.string(),
  source: z.enum(['host', 'account']),
  account_revision: z.coerce.number().nullable(),
  updated_at: z.coerce.number(),
}).transform((row): PersonalDocumentRow => ({
  personKey: row.person_key,
  kind: row.kind,
  content: row.content,
  source: row.source,
  accountRevision: row.account_revision,
  updatedAt: row.updated_at,
}))

/** Whose document changed, so only that person's connections hear it. */
export interface PersonalDocumentChange {
  scope: string
  personKey: string
  kind: PersonalDocumentKind
}

const changeListeners = new Set<(change: PersonalDocumentChange) => void>()

/** Hear each committed write of one person's document. */
export function onPersonalDocumentChanged(listener: (change: PersonalDocumentChange) => void): () => void {
  changeListeners.add(listener)
  return () => { changeListeners.delete(listener) }
}

const COLUMNS = sql`person_key, kind, content, source, account_revision, updated_at`

/** Every person's document of one kind in `scope`. */
export async function listPersonalDocuments(scope: string, kind: PersonalDocumentKind): Promise<PersonalDocumentRow[]> {
  return rowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${COLUMNS} FROM ${personalDocuments}
    WHERE organization_id = ${scope} AND kind = ${kind}
  `))
}

/** One person's document of one kind in `scope`; null when they have none here. */
export async function readPersonalDocument(scope: string, personKey: string, kind: PersonalDocumentKind): Promise<PersonalDocumentRow | null> {
  const rows = rowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${COLUMNS} FROM ${personalDocuments}
    WHERE organization_id = ${scope} AND person_key = ${personKey} AND kind = ${kind}
  `))
  return rows[0] ?? null
}

/** Stores one person's document of one kind in `scope`, in place of the one it had. */
export async function writePersonalDocument(scope: string, row: PersonalDocumentRow): Promise<void> {
  await getDatabase().run(sql`
    INSERT INTO ${personalDocuments} (organization_id, person_key, kind, content, source, account_revision, updated_at)
    VALUES (${scope}, ${row.personKey}, ${row.kind}, ${row.content}, ${row.source}, ${row.accountRevision}, ${row.updatedAt})
    ON CONFLICT (organization_id, person_key, kind) DO UPDATE SET
      content = excluded.content,
      source = excluded.source,
      account_revision = excluded.account_revision,
      updated_at = excluded.updated_at
  `)
  const change: PersonalDocumentChange = { scope, personKey: row.personKey, kind: row.kind }
  void afterDatabaseCommit(async () => {
    for (const listener of changeListeners) listener(change)
  })
}
