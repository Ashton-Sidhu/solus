import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { CODEBASE_ROOTS_MAX, codebaseRootSchema, type Codebase, type CodebaseListOptions, type CodebaseRoot } from '@solus/contracts/codebases'
import { hostPathKey, isAbsoluteHostPath, isInsideHostPath } from '@solus/contracts/host-path'
import type { RecordScope } from '../../admission/principal'
import { getDatabase } from '../../db/database'
import { scopeClause } from '../scope'
import { codebases } from './schema'

/**
 * The codebases this host keeps (docs/plans/codebases.md §5 and decision 6).
 * Each host has the full record of each codebase. A copy moves between hosts
 * as a whole, and the copy with the newest `updatedAt` wins, so a save never
 * changes the copy it stores: two hosts that have the same `updatedAt` have
 * the same record. A delete is a tombstone (`deletedAt`): a client makes it
 * and saves it as each other copy, so it moves as a save does.
 *
 * A read names its scope. A write names one organization. The id of a
 * codebase names one row, and its organization never changes.
 */

const codebaseRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  roots: z.string().transform(parseStoredRoots),
  updated_at: z.number(),
  deleted_at: z.number().nullable(),
})

type CodebaseRow = z.infer<typeof codebaseRowSchema>

const CODEBASE_COLUMNS = sql`id, name, roots, updated_at, deleted_at`

/** The stored roots of a row. A value that cannot be read is no roots; the next save replaces it. */
function parseStoredRoots(stored: string): CodebaseRoot[] {
  try {
    return codebaseRootSchema.array().parse(JSON.parse(stored))
  } catch {
    return []
  }
}

function codebaseFromRow(row: CodebaseRow): Codebase {
  return { id: row.id, name: row.name, roots: row.roots, updatedAt: row.updated_at, deletedAt: row.deleted_at }
}

type CodebaseListener = () => void
const changedListeners = new Set<CodebaseListener>()

/** Hear each save that changed a row. A delete is a save of a tombstone. */
export function onCodebasesChanged(listener: CodebaseListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

function emitChanged(): void {
  for (const listener of changedListeners) listener()
}

/** The codebases in the scope of the reader, by name. A deleted one is left out unless `includeDeleted` is true. */
export async function listCodebases(scope: RecordScope, options: CodebaseListOptions = {}): Promise<Codebase[]> {
  const rows = codebaseRowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${CODEBASE_COLUMNS} FROM ${codebases}
    WHERE ${scopeClause(scope)}${options.includeDeleted ? sql`` : sql` AND deleted_at IS NULL`}
    ORDER BY name, id
  `))
  return rows.map(codebaseFromRow)
}

/** One codebase in the scope of the reader, deleted or not. Null when the host has no copy. */
export async function getCodebase(scope: RecordScope, codebaseId: string): Promise<Codebase | null> {
  const row = codebaseRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT ${CODEBASE_COLUMNS} FROM ${codebases}
    WHERE ${scopeClause(scope)} AND id = ${codebaseId}
  `))
  return row ? codebaseFromRow(row) : null
}

/** The rules of a codebase that the wire schema does not check. Throws a message for the person. */
function assertValidCodebase(codebase: Codebase): void {
  if (!codebase.name.trim()) throw new Error('A codebase needs a name.')
  if (codebase.roots.length > CODEBASE_ROOTS_MAX) throw new Error(`A codebase has at most ${CODEBASE_ROOTS_MAX} folders.`)
  const seen = new Set<string>()
  for (const root of codebase.roots) {
    if (!isAbsoluteHostPath(root.path)) throw new Error(`"${root.path}" is not an absolute path. A folder of a codebase is an absolute path on its host.`)
    const key = `${root.installationId}\0${hostPathKey(root.path)}`
    if (seen.has(key)) throw new Error(`"${root.path}" is in the codebase two times.`)
    seen.add(key)
  }
}

/**
 * Save a copy of a codebase in `organizationId`. The incoming copy replaces
 * the stored one only when its `updatedAt` is newer. Answers the copy the host
 * keeps. A copy of a deleted codebase (a tombstone) is saved by the same rule.
 * `createdBy` applies only when this save makes the row.
 */
export async function saveCodebase(organizationId: string, createdBy: string, codebase: Codebase): Promise<Codebase> {
  assertValidCodebase(codebase)
  const db = getDatabase()
  const written = await db.run(sql`
    INSERT INTO ${codebases} (id, organization_id, created_by, name, roots, updated_at, deleted_at)
    VALUES (${codebase.id}, ${organizationId}, ${createdBy}, ${codebase.name}, ${JSON.stringify(codebase.roots)}, ${codebase.updatedAt}, ${codebase.deletedAt})
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      roots = excluded.roots,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at
    WHERE codebases.organization_id = excluded.organization_id AND excluded.updated_at > codebases.updated_at
  `)
  const kept = await getCodebase(organizationId, codebase.id)
  if (!kept) throw new Error('That codebase belongs to a different organization on this host.')
  if (written.changes) emitChanged()
  return kept
}

/**
 * The codebases, not deleted, that cover `path` on the host `installationId`:
 * `path` is a root, or it is inside a root. One folder can be in several
 * codebases (decision 5).
 */
export async function codebasesOfFolder(scope: RecordScope, installationId: string, path: string): Promise<Codebase[]> {
  const all = await listCodebases(scope)
  return all.filter((codebase) => codebase.roots.some((root) => root.installationId === installationId && isInsideHostPath(root.path, path)))
}
