import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { isRemoteDispatchCheckoutPath, worktreeProjectRoot, type RecentProject } from '../shared/types'
import { getDb, withTx } from './db'
import { isWorkspacePath } from './workspace'
import { z } from 'zod'

const MAX_PROJECTS = 10

interface RecentProjectRow {
  path: string
  folder_name: string
  last_opened: number
}

const recentProjectRowsSchema = z.array(z.object({
  path: z.string(),
  folder_name: z.string(),
  last_opened: z.number(),
}))

function fromRow(row: RecentProjectRow): RecentProject {
  return {
    path: row.path,
    folderName: row.folder_name,
    lastOpened: new Date(row.last_opened).toISOString(),
  }
}

export async function trackRecentProject(path: string): Promise<void> {
  if (!path || path === '~') return
  path = worktreeProjectRoot(path)
  // The workspace is the app's default cwd, not a "project" — never log it.
  if (isWorkspacePath(path)) return
  // A delegated remote-dispatch checkout is host-internal plumbing for running a
  // session on another machine, not a project the user opened — keep it hidden.
  if (isRemoteDispatchCheckoutPath(path)) return
  withTx(() => {
    const db = getDb()
    db.prepare('DELETE FROM recent_projects WHERE path = ?').run(path)
    db.prepare(`
      INSERT INTO recent_projects (path, folder_name, last_opened)
      VALUES (?, ?, ?)
    `).run(path, basename(path) || path, Date.now())
    db.prepare(`
      DELETE FROM recent_projects
      WHERE path IN (
        SELECT path
        FROM recent_projects
        ORDER BY last_opened DESC, rowid DESC
        LIMIT -1 OFFSET ?
      )
    `).run(MAX_PROJECTS)
  })
  // Recents are capped; the manifest keeps the full, permanent list. Keep this
  // import lazy because listProjects reads recents when rebuilding its index.
  const { recordProject } = await import('./project-config/projects-manifest')
  await recordProject(path).catch(() => {})
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  const rows = recentProjectRowsSchema.parse(getDb().prepare(`
    SELECT path, folder_name, last_opened
    FROM recent_projects
    ORDER BY last_opened DESC, rowid DESC
  `).all())
  return rows
    .map(fromRow)
    // Drop rows already written before dispatch checkouts were excluded.
    .filter((project) => !isRemoteDispatchCheckoutPath(project.path) && existsSync(project.path))
}
