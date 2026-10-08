import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path, { basename, isAbsolute, relative, sep } from 'node:path'
import { isRemoteDispatchCheckoutPath, worktreeProjectRoot, type ProjectEntry } from '@solus/contracts/types'
import { isChat } from '@solus/contracts/chat'

/** A folder as the manifest records it. Its repository is read from Git when
 *  the folder is listed to a client (`listProjects` handler), not stored. */
export type ManifestProject = Omit<ProjectEntry, 'repositoryKey'>
import { getDb, withTx } from '../db'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import { resolveProjectKey, resolveProjectRoot } from './project-config'
import { setupProjectsRoot } from '../workspace'
import { z } from 'zod'

const log = createLogger('main', 'projects-manifest')

const PROJECTS_DIR = path.join(solusDir(), 'projects')

/** A session start moves a project's last use at most once in this interval,
 *  so a busy session does not send `projects.changed` on every turn. */
const LAST_USE_INTERVAL_MS = 60_000

type ProjectsListener = () => void
const changedListeners = new Set<ProjectsListener>()

/** Hear every change to this host's project list (`projects.changed`). */
export function onProjectsChanged(listener: ProjectsListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

function emitChanged(): void {
  for (const listener of changedListeners) listener()
}

interface ProjectRow {
  key: string
  path: string
  folder_name: string
  added_at: number
  last_used_at: number | null
}

const projectRowSchema = z.object({
  key: z.string(),
  path: z.string(),
  folder_name: z.string(),
  added_at: z.number(),
  last_used_at: z.number().nullable(),
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
    lastUsedAt: new Date(row.last_used_at ?? row.added_at).toISOString(),
  }
}

async function readManifest(): Promise<ManifestProject[]> {
  const rows = z.array(projectRowSchema).parse(getDb().prepare(`
    SELECT key, path, folder_name, added_at, last_used_at
    FROM projects
  `).all())
  return rows.map(fromRow)
}

/** Whether a session in this path belongs to no project: the home placeholder,
 *  a chat, or a delegated remote-dispatch checkout (host-internal, kept out of
 *  the list the same way recents excludes it). */
/** No folder, a chat, a dispatch clone, or the projects root: the folder that
 *  holds the host's projects and chats is never a project of its own. */
function isOutsideProjects(cwd: string): boolean {
  return !cwd || cwd === '~' || isChat(cwd) || isRemoteDispatchCheckoutPath(cwd)
    || path.resolve(cwd) === path.resolve(setupProjectsRoot())
}

/** Add the project of a folder to the list (docs/plans/project-model.md §2).
 *  The list keeps the project root, so a worktree or a subfolder adds its
 *  repository once. Adding a listed project again moves its last use. */
export async function recordProject(cwd: string): Promise<void> {
  if (isOutsideProjects(cwd)) return
  const root = resolveProjectRoot(cwd)
  if (isOutsideProjects(root)) return
  const now = Date.now()
  getDb().prepare(`
    INSERT INTO projects (key, path, folder_name, added_at, last_used_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET path = excluded.path, folder_name = excluded.folder_name, last_used_at = excluded.last_used_at
  `).run(resolveProjectKey(cwd), root, basename(root) || root, now, now)
  emitChanged()
}

function holds(projectPath: string, folder: string): boolean {
  const inside = relative(projectPath, folder)
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
}

/**
 * A session started in this folder: move the last use of the listed project
 * that is the folder or holds it (a worktree or a subfolder; §3). A folder
 * that is not listed stays off the list. Reads the stored paths, not Git, so a
 * launch never waits on a git process.
 */
export function recordProjectUse(cwd: string): void {
  if (isOutsideProjects(cwd)) return
  const folder = worktreeProjectRoot(cwd)
  const rows = z.array(projectRowSchema.pick({ key: true, path: true })).parse(getDb().prepare('SELECT key, path FROM projects').all())
  const project = rows
    .filter((row) => holds(row.path, folder))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (!project) return
  const now = Date.now()
  const result = getDb().prepare(`
    UPDATE projects SET last_used_at = ?
    WHERE key = ? AND COALESCE(last_used_at, added_at) <= ?
  `).run(now, project.key, now - LAST_USE_INTERVAL_MS)
  if (Number(result.changes) > 0) emitChanged()
}

/** Take a folder's project off the list. Its tasks, sessions, and stored
 *  per-project data stay; adding the folder again lists it again. */
export async function untrackProject(projectPath: string): Promise<void> {
  if (!projectPath) return
  const root = resolveProjectRoot(projectPath)
  let removed = 0
  withTx(() => {
    const db = getDb()
    removed = Number(db.prepare('DELETE FROM projects WHERE path = ? OR key = ?').run(projectPath, resolveProjectKey(projectPath)).changes)
    db.prepare('DELETE FROM recent_projects WHERE path IN (?, ?)').run(projectPath, root)
  })
  if (removed > 0) emitChanged()
}

/** All known projects, most recently used first. Drops entries whose folder no longer exists. */
export async function listProjects(): Promise<ManifestProject[]> {
  const manifest = await readManifest()
  const present = manifest.filter((project) => existsSync(project.path) && !isOutsideProjects(project.path))
  if (present.length !== manifest.length) {
    try {
      const remove = getDb().prepare('DELETE FROM projects WHERE key = ?')
      withTx(() => {
        for (const project of manifest) {
          if (!existsSync(project.path) || isOutsideProjects(project.path)) remove.run(project.key)
        }
      })
    } catch (err) {
      log.warn('projects_manifest_persist_failed', { error: errorMessage(err) })
    }
  }
  return present.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || a.folderName.localeCompare(b.folderName))
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
  emitChanged()
  if (entry) {
    const dir = path.join(PROJECTS_DIR, entry.key)
    await rm(dir, { recursive: true, force: true }).catch((err) =>
      log.warn('project_data_remove_failed', { projectPath, error: errorMessage(err) }),
    )
  }
}
