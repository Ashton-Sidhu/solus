import { hostPathKey } from '@solus/contracts/host-path'
import { runOneAtATime } from '../lib/concurrency'
import { createLogger } from '../logger'
import { runAsync } from './exec'

/**
 * The layout commands of a task folder (docs/plans/codebases.md §7):
 * `worktreeLayout.create` and `worktreeLayout.remove` in the working member's
 * `.solus/config.json`. A command makes, or removes, the checkouts in place
 * of the built-in layout. Solus then adopts only what is a linked worktree of
 * the correct repository on the session's branch (`task-folders.ts`).
 */

const log = createLogger('TaskFolders', 'task-folder-layout-command.ts')

/** A layout command can clone and install. After this time it is stopped. */
const LAYOUT_COMMAND_TIMEOUT_MS = 10 * 60_000

export interface LayoutCommandRun {
  command: string
  /** The folder the command runs in: the working member. */
  workingMember: string
  root: string
  primaryPath: string
  branch: string
  /** Null when the session named no base branch. */
  baseBranch: string | null
  /** The repositories that get a worktree: the chosen ones, and the working member when it is a repository. */
  repositories: readonly string[]
  signal?: AbortSignal
}

/**
 * Run one layout command through the shell, as the acting identity. The
 * commands of one working member run one at a time: they change the same
 * repositories. A command that fails, or that runs for more than ten minutes,
 * is an error with the end of its output.
 */
export function runLayoutCommand(run: LayoutCommandRun): Promise<void> {
  return runOneAtATime(`worktree-layout:${hostPathKey(run.workingMember)}`, async () => {
    const [shell, ...shellArgs] = process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c'] : ['sh', '-c']
    log.info('task_folder_layout_command_started', { root: run.root, workingMember: run.workingMember })
    try {
      await runAsync(shell, [...shellArgs, run.command], run.workingMember, {
        signal: run.signal,
        timeout: LAYOUT_COMMAND_TIMEOUT_MS,
        env: {
          SOLUS_CODEBASE_ROOT: run.workingMember,
          SOLUS_WORKTREE_ROOT: run.root,
          SOLUS_WORKTREE_PRIMARY_PATH: run.primaryPath,
          SOLUS_WORKTREE_BRANCH: run.branch,
          SOLUS_WORKTREE_BASE: run.baseBranch ?? '',
          SOLUS_WORKTREE_REPOSITORIES: run.repositories.join('\n'),
          // An inherited repository would send each Git command of the layout to that repository.
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('task_folder_layout_command_failed', { root: run.root, workingMember: run.workingMember, error: message })
      throw new Error(`The worktree layout command of ${run.workingMember} failed: ${message.trim().split('\n').slice(-5).join('\n')}`, { cause: error })
    }
  })
}
