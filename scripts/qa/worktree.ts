import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type QaWorktreeResult = {
  worktree: string
  branch: string
  readiness: 'ready'
} | {
  worktree: string
  branch: string
  readiness: 'setup_failed'
  error: string
  retryCommand: string
}

type SetupExecutor = (worktree: string) => void

/** Create from this checkout's HEAD. Never borrow dependencies from another checkout. */
export function createQaWorktree(
  root: string,
  branch: string,
  executeSetup: SetupExecutor = (worktree) => {
    execFileSync('bun', ['run', 'qa', 'setup', '--warm'], { cwd: worktree, stdio: 'inherit' })
  },
): QaWorktreeResult {
  const checkout = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim()
  const validation = spawnSync('git', ['check-ref-format', `refs/heads/${branch}`], { cwd: checkout })
  if (!branch || branch.startsWith('-') || validation.status !== 0) {
    throw new Error(`Invalid QA branch name: ${branch}`)
  }
  const existing = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: checkout })
  if (existing.status === 0) throw new Error(`Branch ${branch} already exists. Choose a new QA branch; existing branches are not changed.`)
  if (existing.status !== 1) throw new Error('Could not check existing Git branches')

  const commonDirectory = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: checkout, encoding: 'utf8' }).trim()
  const canonicalCommonDirectory = realpathSync(commonDirectory)
  const solusDirectory = join(canonicalCommonDirectory, 'solus')
  const managedDirectory = join(solusDirectory, 'worktrees')
  // Check each existing ancestor before mkdir can follow it outside the repository.
  for (const directory of [solusDirectory, managedDirectory]) {
    if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('QA worktree directory must not be a symlink')
    }
  }
  mkdirSync(managedDirectory, { recursive: true })
  if (realpathSync(managedDirectory) !== resolve(managedDirectory)) {
    throw new Error('QA worktree directory must not be a symlink')
  }
  const suffix = createHash('sha256').update(branch).digest('hex').slice(0, 12)
  const slug = `${branch.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 80)}-${suffix}`
  const worktree = join(managedDirectory, slug)
  if (existsSync(worktree)) throw new Error(`QA worktree path already exists: ${worktree}`)
  execFileSync('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: checkout, stdio: 'pipe' })

  try {
    executeSetup(worktree)
    return { worktree, branch, readiness: 'ready' }
  } catch (error) {
    // Retain the new branch and checkout for inspection and a safe setup retry.
    const quotedPath = `'${worktree.replace(/'/g, `'"'"'`)}'`
    return {
      worktree,
      branch,
      readiness: 'setup_failed',
      error: String(error),
      retryCommand: `cd ${quotedPath} && bun run qa setup --warm`,
    }
  }
}
