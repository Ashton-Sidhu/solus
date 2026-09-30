import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ShareResource } from '@solus/contracts/sharing'
import type { Publication, PublicationState } from '@solus/contracts/organization-scope'
import { getDb } from '../db'

/**
 * The rows of `publications` (organization-scope §7): one recoverable operation
 * per Local resource on its way into one organization. At most one publication
 * of a resource is active (`pending` or `sent`) at a time — the unique partial
 * index refuses a second — so two Shares, or a Share and an Insights assignment,
 * cannot send the same record to two organizations.
 */

const rowSchema = z.object({
  id: z.string(),
  resource_kind: z.enum(['session', 'work', 'task']),
  resource_id: z.string(),
  organization_id: z.string(),
  actor_user_id: z.string(),
  state: z.enum(['pending', 'sent', 'committed', 'failed']),
  fingerprint: z.string().nullable(),
  through_seq: z.number().nullable(),
  error: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
})
type Row = z.infer<typeof rowSchema>

export interface PublicationRow extends Publication {
  fingerprint: string | null
  /** The highest delivery sequence the publication waits on before it is committed. */
  throughSeq: number | null
}

function fromRow(row: Row): PublicationRow {
  const publication: PublicationRow = {
    id: row.id,
    resource: { kind: row.resource_kind, id: row.resource_id },
    organizationId: row.organization_id,
    actorUserId: row.actor_user_id,
    state: row.state,
    fingerprint: row.fingerprint,
    throughSeq: row.through_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.error) publication.error = row.error
  return publication
}

const COLUMNS = 'id, resource_kind, resource_id, organization_id, actor_user_id, state, fingerprint, through_seq, error, created_at, updated_at'

export function insertPublication(input: { resource: ShareResource; organizationId: string; actorUserId: string }): PublicationRow {
  const now = Date.now()
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO publications(${COLUMNS}) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)
  `).run(id, input.resource.kind, input.resource.id, input.organizationId, input.actorUserId, now, now)
  return readPublication(id)!
}

export function readPublication(id: string): PublicationRow | null {
  const row = rowSchema.nullish().parse(getDb().prepare(`SELECT ${COLUMNS} FROM publications WHERE id = ?`).get(id))
  return row ? fromRow(row) : null
}

/** The one active publication of a resource, or null. */
export function activePublication(resource: ShareResource): PublicationRow | null {
  const row = rowSchema.nullish().parse(getDb().prepare(`
    SELECT ${COLUMNS} FROM publications
    WHERE resource_kind = ? AND resource_id = ? AND state IN ('pending', 'sent')
  `).get(resource.kind, resource.id))
  return row ? fromRow(row) : null
}

/** Every publication still on its way, oldest first: what a restart resumes. */
export function listActivePublications(): PublicationRow[] {
  return rowSchema.array().parse(getDb().prepare(`
    SELECT ${COLUMNS} FROM publications WHERE state IN ('pending', 'sent') ORDER BY created_at
  `).all()).map(fromRow)
}

export function listPublications(resource?: ShareResource): PublicationRow[] {
  const rows = resource
    ? getDb().prepare(`SELECT ${COLUMNS} FROM publications WHERE resource_kind = ? AND resource_id = ? ORDER BY created_at DESC`).all(resource.kind, resource.id)
    : getDb().prepare(`SELECT ${COLUMNS} FROM publications ORDER BY created_at DESC LIMIT 200`).all()
  return rowSchema.array().parse(rows).map(fromRow)
}

export function updatePublication(id: string, patch: { state?: PublicationState; fingerprint?: string | null; throughSeq?: number | null; error?: string | null }): PublicationRow {
  const current = readPublication(id)
  if (!current) throw new Error(`Publication not found: ${id}`)
  getDb().prepare(`
    UPDATE publications SET state = ?, fingerprint = ?, through_seq = ?, error = ?, updated_at = ? WHERE id = ?
  `).run(
    patch.state ?? current.state,
    patch.fingerprint === undefined ? current.fingerprint : patch.fingerprint,
    patch.throughSeq === undefined ? current.throughSeq : patch.throughSeq,
    patch.error === undefined ? (current.error ?? null) : patch.error,
    Date.now(),
    id,
  )
  return readPublication(id)!
}
