import { statSync } from 'fs'
import path from 'path'
import { SOLUS_WORKTREE_DIR } from '@solus/contracts/types'

/**
 * Absolute path for a managed worktree of `projectPath`.
 *
 * Worktrees live inside the git directory, which is not part of the working
 * tree — that is what spares every project a `.gitignore` entry. `.git` is a
 * plain file, not a directory, in a submodule or a linked worktree, so a caller
 * that passed one of those would build a path through a file and fail deep
 * inside `git worktree add`. Every caller resolves the main repository root
 * first; fail by name if one stops.
 */
export function worktreePathFor(projectPath: string, slug: string): string {
  const gitDir = path.join(projectPath, '.git')
  if (!statSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `Cannot place a worktree for ${projectPath}: ${gitDir} is not a directory. Resolve the main repository root first.`,
    )
  }
  return path.join(projectPath, SOLUS_WORKTREE_DIR, slug)
}
