import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { RecentProject } from '../shared/types'
import { getDb, withTx } from './db'
import { isWorkspacePath } from './workspace'

const MAX_PROJECTS = 10

interface RecentProjectRow {
  path: string
  folder_name: string
  last_opened: number
}

function fromRow(row: RecentProjectRow): RecentProject {
  return {
    path: row.path,
    folderName: row.folder_name,
    lastOpened: new Date(row.last_opened).toISOString(),
  }
}

export async function trackRecentProject(path: string): Promise<void> {
  if (!path || path === '~') return
  // The workspace is the app's default cwd, not a "project" — never log it.
  if (isWorkspacePath(path)) return
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
  const rows = getDb().prepare(`
    SELECT path, folder_name, last_opened
    FROM recent_projects
    ORDER BY last_opened DESC, rowid DESC
  `).all() as unknown as RecentProjectRow[]
  return rows.filter((row) => existsSync(row.path)).map(fromRow)
}
