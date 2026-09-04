import { existsSync } from 'node:fs'
import path from 'node:path'
import { runAsync } from './exec'

/** Git can retain REBASE_HEAD after a successful rebase. Active rebases are
 * represented by rebase-merge or rebase-apply; the other operations use refs. */
export async function isGitOperationInProgress(cwd: string): Promise<boolean> {
  const paths = await runAsync('git', [
    'rev-parse',
    '--git-path', 'MERGE_HEAD',
    '--git-path', 'rebase-merge',
    '--git-path', 'rebase-apply',
    '--git-path', 'CHERRY_PICK_HEAD',
  ], cwd).catch(() => '')

  return paths
    .split('\n')
    .some((candidate) => candidate.trim() && existsSync(path.resolve(cwd, candidate.trim())))
}
