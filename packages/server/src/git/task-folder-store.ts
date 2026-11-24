import { realpathSync } from 'node:fs'
import { z } from 'zod'
import { taskFolderRootOf, type TaskFolder } from '@solus/contracts/codebases'
import { worktreeProjectRoot } from '@solus/contracts/types'
import { getDb } from '../db'
import { isInsideRoot } from '../paths'

/**
 * The record of each task folder on this host (docs/plans/codebases.md §7):
 * the `task_folders` host table. `task-folders.ts` owns each change of a task
 * folder and writes here; a reader asks `findTaskFolderContaining`.
 */

/** A task folder as this host records it. */
export interface TaskFolderRecord extends TaskFolder {
  /** The codebase of the session that made it. Null for a session with no codebase. */
  codebaseId: string | null
  /**
   * The session that the task folder was made for. Null until the creation
   * ends, so a creation that the host did not finish names no session.
   */
  sessionId: string | null
  /** Epoch milliseconds. */
  createdAt: number
}

const repositoriesSchema = z.array(z.object({
  repositoryPath: z.string(),
  worktreePath: z.string(),
  name: z.string(),
}))

const rowSchema = z.object({
  root: z.string(),
  codebase_id: z.string().nullable(),
  session_id: z.string().nullable(),
  anchor: z.string(),
  primary_path: z.string(),
  primary_repository_path: z.string(),
  primary_is_worktree: z.number(),
  branch: z.string(),
  repositories: z.string(),
  created_at: z.number(),
})

const COLUMNS = 'root, codebase_id, session_id, anchor, primary_path, primary_repository_path, primary_is_worktree, branch, repositories, created_at'

function fromRow(row: z.infer<typeof rowSchema>): TaskFolderRecord {
  return {
    root: row.root,
    anchor: row.anchor,
    primaryPath: row.primary_path,
    primaryRepositoryPath: row.primary_repository_path,
    primaryIsWorktree: row.primary_is_worktree === 1,
    branch: row.branch,
    repositories: repositoriesSchema.parse(JSON.parse(row.repositories)),
    codebaseId: row.codebase_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
  }
}

/**
 * The task folder that is, or holds, `path`. The name of the folder is the
 * mark (`taskFolderRootOf`), so only one ancestor of `path` can be a root. It
 * is compared with both spellings of each root: the one Solus made, and the
 * one after links are resolved, which a process reports.
 */
export function findTaskFolderContaining(path: string): TaskFolderRecord | null {
  const root = taskFolderRootOf(path)
  if (!root) return null
  const row = rowSchema.nullish().parse(getDb().prepare(`SELECT ${COLUMNS} FROM task_folders WHERE root = ? OR real_root = ? LIMIT 1`).get(root, root))
  return row ? fromRow(row) : null
}

/**
 * The project folder that `path` belongs to. A worktree inside its repository
 * answers the repository (`worktreeProjectRoot`). A task folder path answers
 * the folder that its place stands in for: the repository of the worktree that
 * holds it, else the working member of the task folder. Each other path, and a
 * path in a task folder that has no record, is its own answer.
 *
 * It reads the host table, not Git, so a reader on a hot path does not wait.
 */
export function projectRootOfPath(path: string): string {
  const root = taskFolderRootOf(path)
  if (!root) return worktreeProjectRoot(path)
  const record = findTaskFolderContaining(path)
  if (!record) return path
  // The record has the spelling Solus made. `path` can have the one after links are resolved.
  const place = record.root + path.slice(root.length)
  const holder = record.repositories
    .filter((repository) => isInsideRoot(repository.worktreePath, place))
    .sort((a, b) => b.worktreePath.length - a.worktreePath.length)[0]
  return holder?.repositoryPath ?? record.primaryRepositoryPath
}

/** Each task folder of this host, the oldest first. */
export function listTaskFolders(): TaskFolderRecord[] {
  return z.array(rowSchema).parse(getDb().prepare(`SELECT ${COLUMNS} FROM task_folders ORDER BY created_at, root`).all()).map(fromRow)
}

/** Write the record of a task folder. A record with the same root is replaced. */
export function putTaskFolder(record: TaskFolderRecord): void {
  let realRoot = record.root
  // The folder can be gone when the record of a partly removed task folder is written again.
  try { realRoot = realpathSync(record.root) } catch { /* the spelling Solus made is the only one */ }
  getDb().prepare(`
    INSERT INTO task_folders (root, real_root, codebase_id, session_id, anchor, primary_path, primary_repository_path, primary_is_worktree, branch, repositories, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(root) DO UPDATE SET
      real_root = excluded.real_root, codebase_id = excluded.codebase_id, session_id = excluded.session_id, anchor = excluded.anchor,
      primary_path = excluded.primary_path, primary_repository_path = excluded.primary_repository_path,
      primary_is_worktree = excluded.primary_is_worktree, branch = excluded.branch, repositories = excluded.repositories
  `).run(
    record.root, realRoot, record.codebaseId, record.sessionId, record.anchor, record.primaryPath, record.primaryRepositoryPath,
    record.primaryIsWorktree ? 1 : 0, record.branch, JSON.stringify(record.repositories), record.createdAt,
  )
}

/** Delete the record of a task folder. Nothing there is not an error. */
export function removeTaskFolderRecord(root: string): void {
  getDb().prepare('DELETE FROM task_folders WHERE root = ?').run(root)
}
