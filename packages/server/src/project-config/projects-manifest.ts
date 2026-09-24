import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path, { basename } from 'node:path'
import { isRemoteDispatchCheckoutPath, type ProjectEntry } from '@solus/contracts/types'

/** A folder as the manifest records it. Its repository is read from Git when
 *  the folder is listed to a client (`listProjects` handler), not stored. */
export type ManifestProject = Omit<ProjectEntry, 'repositoryKey'>
import { getDb, withTx } from '../db'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import { resolveProjectKey } from './project-config'
import { z } from 'zod'

const log = createLogger('main', 'projects-manifest')

const PROJECTS_DIR = path.join(solusDir(), 'projects')

interface ProjectRow {
  key: string
  path: string
  folder_name: string
  added_at: number
}

const projectRowSchema = z.object({
  key: z.string(),
  path: z.string(),
  folder_name: z.string(),
  added_at: z.number(),
})

function errorMessage(error: Parameters<typeof String>[0]): string {
  return error instanceof Error ? error.message : String(error)
}

function fromRow(row: ProjectRow): ManifestProject {
  return {
    key: row.key,
    path: row.path,
    folderName: row.folder_name,
    addedAt: new Date(row.added_at).toISOString(),
  }
}

async function readManifest(): Promise<ManifestProject[]> {
  const rows = z.array(projectRowSchema).parse(getDb().prepare(`
    SELECT key, path, folder_name, added_at
    FROM projects
  `).all())
  return rows.map(fromRow)
}

/** Add a project to the manifest if not already present (keyed by its config hash). */
export async function recordProject(cwd: string): Promise<void> {
  if (!cwd || cwd === '~') return
  // Delegated remote-dispatch checkouts are host-internal; keep them out of the
  // permanent project list the same way recents excludes them.
  if (isRemoteDispatchCheckoutPath(cwd)) return
  const key = resolveProjectKey(cwd)
  getDb().prepare(`
    INSERT OR IGNORE INTO projects (key, path, folder_name, added_at)
    VALUES (?, ?, ?, ?)
  `).run(key, cwd, basename(cwd) || cwd, Date.now())
}

/** All known projects. Drops entries whose folder no longer exists. */
export async function listProjects(): Promise<ManifestProject[]> {
  const manifest = await readManifest()
  const present = manifest.filter((project) => existsSync(project.path))
  if (present.length !== manifest.length) {
    try {
      const remove = getDb().prepare('DELETE FROM projects WHERE key = ?')
      withTx(() => {
        for (const project of manifest) {
          if (!existsSync(project.path)) remove.run(project.key)
        }
      })
    } catch (err) {
      log.warn('projects_manifest_persist_failed', { error: errorMessage(err) })
    }
  }
  return present.sort((a, b) => a.folderName.localeCompare(b.folderName))
}

/** Remove a project from the manifest and delete its stored per-project data. */
export async function deleteProject(projectPath: string): Promise<void> {
  if (!projectPath) return
  const projects = await readManifest()
  const entry = projects.find((project) => project.path === projectPath)
  withTx(() => {
    const db = getDb()
    if (entry) {
      db.prepare('DELETE FROM tasks WHERE project_key = ?').run(entry.key)
      db.prepare('DELETE FROM task_session_links WHERE project_key = ?').run(entry.key)
      db.prepare('DELETE FROM task_cache WHERE project_key = ?').run(entry.key)
    }
    db.prepare('DELETE FROM recent_projects WHERE path = ?').run(projectPath)
    db.prepare('DELETE FROM projects WHERE path = ?').run(projectPath)
  })
  if (entry) {
    const dir = path.join(PROJECTS_DIR, entry.key)
    await rm(dir, { recursive: true, force: true }).catch((err) =>
      log.warn('project_data_remove_failed', { projectPath, error: errorMessage(err) }),
    )
  }
}
