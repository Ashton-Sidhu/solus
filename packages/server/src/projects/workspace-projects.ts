import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { isRepositoryKey, repositoryKeyFromRemoteUrl } from '@solus/contracts/repository-key'
import type { WorkspaceProject, WorkspaceProjectAddRequest, WorkspaceProjectPatch } from '@solus/contracts/workspace-projects'
import { recordScopeOf } from '../admission/principal'
import { ownerKeyOf, type Actor } from '../admission/actor'
import { roleOf } from '../admission/access'
import { hostUserKey } from '../host/host-user'
import { scopeClause } from '../data/scope'
import { getDatabase } from '../db/database'
import { ulid } from '@solus/contracts/ulid'
import { workspaceProjects } from './schema'

/**
 * The organization's projects (docs/plans/project-model.md §2). Every read and
 * write names the organization; a project is found by its repository key, so a
 * second add of one repository answers the row the first add made. Every member
 * lists the directory; a project has one owner, the person who added it, and an
 * update or a removal passed the gate with `project.edit` (docs/plans/access-model.md §2.3).
 * Each read carries the reader's role on the project (§2.7), so a client offers
 * rename and remove only to who may do them.
 */

const projectRowSchema = z.object({
  id: z.string(),
  repository_key: z.string(),
  display_name: z.string(),
  default_branch: z.string().nullable(),
  organization_id: z.string(),
  owner_key: z.string(),
  created_by: z.string().nullable(),
  created_at: z.number(),
})

type ProjectRow = z.infer<typeof projectRowSchema>

const PROJECT_COLUMNS = sql`id, repository_key, display_name, default_branch, organization_id, owner_key, created_by, created_at`

function projectFromRow(row: ProjectRow, reader: Actor): WorkspaceProject {
  return {
    id: row.id,
    repositoryKey: row.repository_key,
    displayName: row.display_name,
    defaultBranch: row.default_branch,
    createdBy: row.created_by,
    createdAt: row.created_at,
    role: roleOf(reader, { kind: 'project', id: row.id, organizationId: row.organization_id, ownerKey: row.owner_key, acl: [] }),
  }
}

type ProjectListener = () => void
const changedListeners = new Set<ProjectListener>()

/** Hear every change to any organization's project directory. */
export function onWorkspaceProjectsChanged(listener: ProjectListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

function emitChanged(): void {
  for (const listener of changedListeners) listener()
}

/** Every project in the reader's organization scope. */
export async function listWorkspaceProjects(reader: Actor): Promise<WorkspaceProject[]> {
  const rows = projectRowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${PROJECT_COLUMNS} FROM ${workspaceProjects}
    WHERE ${scopeClause(recordScopeOf(reader.principal))}
    ORDER BY display_name
  `))
  return rows.map((row) => projectFromRow(row, reader))
}

async function findByRepositoryKey(organizationId: string, repositoryKey: string, reader: Actor): Promise<WorkspaceProject | null> {
  const row = projectRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT ${PROJECT_COLUMNS} FROM ${workspaceProjects}
    WHERE organization_id = ${organizationId} AND repository_key = ${repositoryKey}
  `))
  return row ? projectFromRow(row, reader) : null
}

/** A repository key as the caller wrote it — a key, or a clone URL — in canonical form. */
function canonicalRepositoryKey(input: string): string | null {
  const trimmed = input.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')
  if (isRepositoryKey(trimmed) && trimmed.split('/').length >= 3) return trimmed
  return repositoryKeyFromRemoteUrl(input)
}

/** Adds a project the adder owns; a repository already in the organization answers its row. */
export async function addWorkspaceProject(
  organizationId: string,
  request: WorkspaceProjectAddRequest,
  adder: Actor,
  createdBy: string | null,
): Promise<WorkspaceProject> {
  const repositoryKey = canonicalRepositoryKey(request.repositoryKey)
  if (!repositoryKey) throw new Error(`"${request.repositoryKey}" does not name a hosted repository.`)
  const existing = await findByRepositoryKey(organizationId, repositoryKey, adder)
  if (existing) return existing
  const ownerKey = ownerKeyOf(adder) ?? hostUserKey()
  const now = Date.now()
  const projectId = ulid(now)
  const displayName = request.displayName?.trim() || repositoryKey.split('/').at(-1)!
  // A concurrent add of the same repository loses to the unique index and
  // reads back the winner's row.
  await getDatabase().run(sql`
    INSERT INTO ${workspaceProjects} (id, organization_id, repository_key, display_name, default_branch, owner_key, created_by, created_at)
    VALUES (${projectId}, ${organizationId}, ${repositoryKey}, ${displayName}, NULL, ${ownerKey}, ${createdBy}, ${now})
    ON CONFLICT (organization_id, repository_key) DO NOTHING
  `)
  const stored = await findByRepositoryKey(organizationId, repositoryKey, adder)
  if (!stored) throw new Error('The project could not be saved.')
  if (stored.id === projectId) emitChanged()
  return stored
}

export async function updateWorkspaceProject(
  editor: Actor,
  projectId: string,
  patch: WorkspaceProjectPatch,
): Promise<WorkspaceProject> {
  const displayName = patch.displayName?.trim()
  if (patch.displayName !== undefined && !displayName) throw new Error('A project needs a name.')
  const defaultBranch = patch.defaultBranch === undefined ? undefined : patch.defaultBranch?.trim() || null
  const scope = recordScopeOf(editor.principal)
  const db = getDatabase()
  if (displayName !== undefined) {
    await db.run(sql`UPDATE ${workspaceProjects} SET display_name = ${displayName} WHERE ${scopeClause(scope)} AND id = ${projectId}`)
  }
  if (defaultBranch !== undefined) {
    await db.run(sql`UPDATE ${workspaceProjects} SET default_branch = ${defaultBranch} WHERE ${scopeClause(scope)} AND id = ${projectId}`)
  }
  const row = projectRowSchema.nullish().parse(await db.get(sql`
    SELECT ${PROJECT_COLUMNS} FROM ${workspaceProjects}
    WHERE ${scopeClause(scope)} AND id = ${projectId}
  `))
  if (!row) throw new Error('That project is no longer in the organization.')
  emitChanged()
  return projectFromRow(row, editor)
}

export async function removeWorkspaceProject(remover: Actor, projectId: string): Promise<void> {
  await getDatabase().run(sql`
    DELETE FROM ${workspaceProjects} WHERE ${scopeClause(recordScopeOf(remover.principal))} AND id = ${projectId}
  `)
  emitChanged()
}
