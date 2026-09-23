import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { isRepositoryKey, repositoryKeyFromRemoteUrl } from '@solus/contracts/repository-key'
import type { WorkspaceProject, WorkspaceProjectAddRequest, WorkspaceProjectPatch } from '@solus/contracts/workspace-projects'
import { getDatabase } from '../db/database'
import { ulid } from '@solus/contracts/ulid'
import { workspaceProjects } from './schema'

/**
 * The organization's projects (docs/plans/project-model.md §2). Every read and
 * write names the organization; a project is found by its repository key, so a
 * second add of one repository answers the row the first add made.
 */

const projectRowSchema = z.object({
  id: z.string(),
  repository_key: z.string(),
  display_name: z.string(),
  default_branch: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.number(),
})

type ProjectRow = z.infer<typeof projectRowSchema>

const PROJECT_COLUMNS = sql`id, repository_key, display_name, default_branch, created_by, created_at`

function projectFromRow(row: ProjectRow): WorkspaceProject {
  return {
    id: row.id,
    repositoryKey: row.repository_key,
    displayName: row.display_name,
    defaultBranch: row.default_branch,
    createdBy: row.created_by,
    createdAt: row.created_at,
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

export async function listWorkspaceProjects(organizationId: string): Promise<WorkspaceProject[]> {
  const rows = projectRowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${PROJECT_COLUMNS} FROM ${workspaceProjects}
    WHERE organization_id = ${organizationId}
    ORDER BY display_name
  `))
  return rows.map(projectFromRow)
}

async function findByRepositoryKey(organizationId: string, repositoryKey: string): Promise<WorkspaceProject | null> {
  const row = projectRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT ${PROJECT_COLUMNS} FROM ${workspaceProjects}
    WHERE organization_id = ${organizationId} AND repository_key = ${repositoryKey}
  `))
  return row ? projectFromRow(row) : null
}

/** A repository key as the caller wrote it — a key, or a clone URL — in canonical form. */
function canonicalRepositoryKey(input: string): string | null {
  const trimmed = input.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')
  if (isRepositoryKey(trimmed) && trimmed.split('/').length >= 3) return trimmed
  return repositoryKeyFromRemoteUrl(input)
}

export async function addWorkspaceProject(
  organizationId: string,
  request: WorkspaceProjectAddRequest,
  createdBy: string | null,
): Promise<WorkspaceProject> {
  const repositoryKey = canonicalRepositoryKey(request.repositoryKey)
  if (!repositoryKey) throw new Error(`"${request.repositoryKey}" does not name a hosted repository.`)
  const existing = await findByRepositoryKey(organizationId, repositoryKey)
  if (existing) return existing
  const now = Date.now()
  const project: WorkspaceProject = {
    id: ulid(now),
    repositoryKey,
    displayName: request.displayName?.trim() || repositoryKey.split('/').slice(1).join('/'),
    defaultBranch: null,
    createdBy,
    createdAt: now,
  }
  // A concurrent add of the same repository loses to the unique index and
  // reads back the winner's row.
  await getDatabase().run(sql`
    INSERT INTO ${workspaceProjects} (id, organization_id, repository_key, display_name, default_branch, created_by, created_at)
    VALUES (${project.id}, ${organizationId}, ${project.repositoryKey}, ${project.displayName}, NULL, ${createdBy}, ${now})
    ON CONFLICT (organization_id, repository_key) DO NOTHING
  `)
  const stored = await findByRepositoryKey(organizationId, repositoryKey)
  if (!stored) throw new Error('The project could not be saved.')
  if (stored.id === project.id) emitChanged()
  return stored
}

export async function updateWorkspaceProject(
  organizationId: string,
  projectId: string,
  patch: WorkspaceProjectPatch,
): Promise<WorkspaceProject> {
  const displayName = patch.displayName?.trim()
  if (patch.displayName !== undefined && !displayName) throw new Error('A project needs a name.')
  const defaultBranch = patch.defaultBranch === undefined ? undefined : patch.defaultBranch?.trim() || null
  const db = getDatabase()
  if (displayName !== undefined) {
    await db.run(sql`UPDATE ${workspaceProjects} SET display_name = ${displayName} WHERE organization_id = ${organizationId} AND id = ${projectId}`)
  }
  if (defaultBranch !== undefined) {
    await db.run(sql`UPDATE ${workspaceProjects} SET default_branch = ${defaultBranch} WHERE organization_id = ${organizationId} AND id = ${projectId}`)
  }
  const row = projectRowSchema.nullish().parse(await db.get(sql`
    SELECT ${PROJECT_COLUMNS} FROM ${workspaceProjects}
    WHERE organization_id = ${organizationId} AND id = ${projectId}
  `))
  if (!row) throw new Error('That project is no longer in the organization.')
  emitChanged()
  return projectFromRow(row)
}

export async function removeWorkspaceProject(organizationId: string, projectId: string): Promise<void> {
  await getDatabase().run(sql`
    DELETE FROM ${workspaceProjects} WHERE organization_id = ${organizationId} AND id = ${projectId}
  `)
  emitChanged()
}
