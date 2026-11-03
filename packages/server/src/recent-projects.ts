import { existsSync } from 'node:fs'
import { worktreeProjectRoot, type RecentProject } from '@solus/contracts/types'
import { getDb } from './db'
import { isChat } from '@solus/contracts/chat'
import { recordProject } from './project-config/projects-manifest'
import { z } from 'zod'

/**
 * Recents are the project list ordered by last use (plan 029 §3.7): `projects`
 * is the one owner of when a project was used, and the directory picker shows
 * the newest few. A recent is the repository root, as the project list shows
 * it; a worktree opened inside a repository counts as a use of that repository.
 */

const MAX_PROJECTS = 10

const recentProjectRowsSchema = z.array(z.object({
  path: z.string(),
  folder_name: z.string(),
  last_used_at: z.number(),
}))

export async function trackRecentProject(path: string): Promise<void> {
  if (!path || path === '~') return
  path = worktreeProjectRoot(path)
  // A chat is a session with no project — never log its folder as one.
  if (isChat(path)) return
  await recordProject(path).catch(() => {})
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  const rows = recentProjectRowsSchema.parse(getDb().prepare(`
    SELECT path, folder_name, COALESCE(last_used_at, added_at) AS last_used_at
    FROM projects
    WHERE path IS NOT NULL AND folder_name IS NOT NULL
    ORDER BY COALESCE(last_used_at, added_at) DESC, key
    LIMIT ?
  `).all(MAX_PROJECTS))
  return rows
    .map((row) => ({ path: row.path, folderName: row.folder_name, lastOpened: new Date(row.last_used_at).toISOString() }))
    .filter((project) => existsSync(project.path))
}
