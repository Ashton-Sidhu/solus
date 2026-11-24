import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { CODEBASE_ROOTS_MAX, CODEBASE_ROOTS_MIN, codebaseRootSchema, hasEnoughRoots, type Codebase, type CodebaseListOptions, type CodebaseRoot } from '@solus/contracts/codebases'
import { codebaseRootKey, codebasesHolding } from '@solus/client-core/codebases'
import { isAbsoluteHostPath, isInsideHostPath } from '@solus/contracts/host-path'
import { ownerKeyOf, type Actor } from '../../admission/actor'
import { organizationForNew, recordScopeOf, type RecordScope } from '../../admission/principal'
import { hostUserKey } from '../../host/host-user'
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
 * A codebase that is not deleted has two or more roots, or one container
 * root (decision 14): one project is never a codebase. A stored row that is
 * not deleted and has fewer roots is not a codebase, so no read answers it.
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

/** A row that a read answers: a tombstone, or a codebase with the least number of roots, or with a container root. */
function isCodebase(codebase: Codebase): boolean {
  return codebase.deletedAt !== null || hasEnoughRoots(codebase.roots)
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
  return rows.map(codebaseFromRow).filter(isCodebase)
}

/** The stored row of an id in the scope of the reader, whatever it holds. */
async function storedCodebase(scope: RecordScope, codebaseId: string): Promise<Codebase | null> {
  const row = codebaseRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT ${CODEBASE_COLUMNS} FROM ${codebases}
    WHERE ${scopeClause(scope)} AND id = ${codebaseId}
  `))
  return row ? codebaseFromRow(row) : null
}

/** One codebase in the scope of the reader, deleted or not. Null when the host has no copy. */
export async function getCodebase(scope: RecordScope, codebaseId: string): Promise<Codebase | null> {
  const stored = await storedCodebase(scope, codebaseId)
  return stored && isCodebase(stored) ? stored : null
}

/** The rules of a codebase that the wire schema does not check. Throws a message for the person. */
function assertValidCodebase(codebase: Codebase): void {
  if (!codebase.name.trim()) throw new Error('A codebase needs a name.')
  if (codebase.roots.length > CODEBASE_ROOTS_MAX) throw new Error(`A codebase has at most ${CODEBASE_ROOTS_MAX} folders.`)
  const seen = new Set<string>()
  for (const root of codebase.roots) {
    if (!isAbsoluteHostPath(root.path)) throw new Error(`"${root.path}" is not an absolute path. A folder of a codebase is an absolute path on its host.`)
    const key = codebaseRootKey(root)
    if (seen.has(key)) throw new Error(`"${root.path}" is in the codebase two times.`)
    seen.add(key)
  }
  // A tombstone keeps the roots that its codebase had: the rules below are for a codebase that is not deleted.
  if (codebase.deletedAt !== null) return
  if (!hasEnoughRoots(codebase.roots)) {
    throw new Error(`A codebase has at least ${CODEBASE_ROOTS_MIN} folders, or one folder that holds two or more repositories. One folder is a project.`)
  }
  for (const root of codebase.roots) {
    const holder = codebase.roots.find((other) => other !== root && other.installationId === root.installationId && isInsideHostPath(other.path, root.path))
    if (holder) throw new Error(`"${root.path}" is inside "${holder.path}", which is in the codebase. A folder of a codebase covers the folders inside it.`)
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
  const kept = await storedCodebase(organizationId, codebase.id)
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
  return codebasesHolding(await listCodebases(scope), { installationId, path })
}

/** The codebases as one person reads and changes them. */
export interface ActorCodebases {
  list(options?: CodebaseListOptions): Promise<Codebase[]>
  get(codebaseId: string): Promise<Codebase | null>
  ofFolder(installationId: string, path: string): Promise<Codebase[]>
  /** A save in the organization of a new record of the person. When it makes the row, the person is its creator. */
  save(codebase: Codebase): Promise<Codebase>
}

/**
 * The codebases in the scope of `actor`. A read names the scope of the
 * person, and a save names the organization and the creator of the person,
 * so each caller does not build them. The scope is read at each call.
 */
export function codebasesFor(actor: Actor): ActorCodebases {
  return {
    list: (options) => listCodebases(recordScopeOf(actor.principal), options),
    get: (codebaseId) => getCodebase(recordScopeOf(actor.principal), codebaseId),
    ofFolder: (installationId, path) => codebasesOfFolder(recordScopeOf(actor.principal), installationId, path),
    save: (codebase) => saveCodebase(organizationForNew(actor.principal), ownerKeyOf(actor) ?? hostUserKey(), codebase),
  }
}
