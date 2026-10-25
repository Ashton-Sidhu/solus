import { createHash } from 'node:crypto'
import { gitOutputPath } from '../git/exec'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveHomePath } from '../platform/paths'
import { DeviceDomainError } from './device-errors'
import type { DeviceCommandRunner } from './device-process'

// A snapshot commit is referenced by nothing, so the project's upload-pack
// must be allowed to send it to the owned checkout.
const SNAPSHOT_UPLOAD_PACK = 'git -c uploadpack.allowAnySHA1InWant=true upload-pack'
// A fixed identity and date give the same working state the same commit, so
// an unchanged source skips setup on the next run.
const SNAPSHOT_IDENTITY = { GIT_AUTHOR_NAME: 'Solus', GIT_AUTHOR_EMAIL: 'builds@solus.sh', GIT_AUTHOR_DATE: '@0 +0000', GIT_COMMITTER_NAME: 'Solus', GIT_COMMITTER_EMAIL: 'builds@solus.sh', GIT_COMMITTER_DATE: '@0 +0000' }

/**
 * A checkout Solus owns, moved on each run to the current state of its source:
 * the newest commit plus the uncommitted and untracked changes of the working
 * tree that has the branch checked out.
 */
export class DeviceRunSources {
  constructor(private readonly root: string, private readonly run: DeviceCommandRunner, private readonly env: NodeJS.ProcessEnv) {}

  async prepare(project: string, source: 'main' | 'conversation' = 'main', branch?: string): Promise<{ path: string; commit: string; hasChangedSource: boolean }> {
    const directory = join(this.root, createHash('sha256').update(`${project}\u0000${branch ?? source}`).digest('hex').slice(0, 24))
    const path = join(directory, 'checkout')
    const lastSourcePath = join(directory, 'commit')
    await mkdir(directory, { recursive: true })
    const previous = await readFile(lastSourcePath, 'utf8').catch(() => null)
    const commit = (branch ? await this.branchCommit(project, branch) : await this.git(project, ['rev-parse', '--verify', source === 'main' ? 'refs/heads/main^{commit}' : 'HEAD^{commit}'])).trim()
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new DeviceDomainError('invalid_request', 'The selected branch has no commit. Choose another branch.')
    const workingTree = !branch && source === 'conversation' ? project : await this.workingTreeOf(project, branch ?? 'main')
    const snapshot = workingTree ? await this.snapshot(workingTree, commit) : commit
    if (!(await stat(join(path, '.git')).catch(() => null))) {
      await this.git(directory, ['clone', '--no-hardlinks', '--no-checkout', '--', project, path])
    }
    const known = await this.run('git', ['cat-file', '-e', `${snapshot}^{commit}`], { cwd: resolveHomePath(path), timeoutMs: 10_000 })
    if (known.code !== 0) await this.git(path, ['fetch', '--no-tags', '--upload-pack', SNAPSHOT_UPLOAD_PACK, 'origin', snapshot])
    await this.git(path, ['checkout', '--force', '--detach', snapshot])
    await writeFile(lastSourcePath, snapshot, { mode: 0o600 })
    return { path, commit, hasChangedSource: previous !== snapshot }
  }

  /** The worktree that has the branch checked out, if any; a remote-only branch has none. */
  private async workingTreeOf(project: string, branch: string): Promise<string | null> {
    const list = await this.git(project, ['worktree', 'list', '--porcelain'])
    for (const entry of list.split('\n\n')) {
      const lines = entry.split('\n')
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
      if (lines.includes(`branch refs/heads/${branch}`)) return path ? gitOutputPath(project, path) : null
    }
    return null
  }

  /**
   * Records the working tree, uncommitted and untracked files included, as a
   * commit on top of HEAD. A copy of its index is used, so the person's
   * staging and files stay as they are. Ignored files are left out.
   */
  private async snapshot(workingTree: string, commit: string): Promise<string> {
    const head = await this.git(workingTree, ['rev-parse', '--verify', 'HEAD^{commit}'])
    if (head !== commit) return commit
    const temporary = await mkdtemp(join(tmpdir(), 'solus-run-index-'))
    try {
      const index = join(temporary, 'index')
      const realIndex = await this.git(workingTree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
      await copyFile(realIndex, index).catch(() => {})
      const env = { ...this.env, ...SNAPSHOT_IDENTITY, GIT_INDEX_FILE: index }
      await this.git(workingTree, ['add', '--all'], env)
      const tree = await this.git(workingTree, ['write-tree'], env)
      if (tree === await this.git(workingTree, ['rev-parse', `${commit}^{tree}`])) return commit
      return await this.git(workingTree, ['commit-tree', tree, '-p', commit, '-m', 'Solus build snapshot'], env)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  private async branchCommit(project: string, branch: string): Promise<string> {
    const valid = await this.run('git', ['check-ref-format', `refs/heads/${branch}`], { cwd: resolveHomePath(project), timeoutMs: 10_000 })
    if (valid.code !== 0) throw new DeviceDomainError('invalid_request', 'Choose a valid branch name.')
    const local = await this.run('git', ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { cwd: resolveHomePath(project), timeoutMs: 10_000 })
    if (local.code === 0) return local.stdout.trim()
    const refs = await this.git(project, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes'])
    const commits = new Set(refs.split('\n').filter((line) => {
      const ref = line.split(' ')[1] ?? ''
      return ref.replace(/^refs\/remotes\/[^/]+\//, '') === branch && !ref.endsWith('/HEAD')
    }).map((line) => line.split(' ')[0]!))
    if (commits.size !== 1) throw new DeviceDomainError('invalid_request', commits.size ? 'This branch differs between remotes. Create a local branch first.' : 'That branch is no longer available. Choose another branch.')
    return [...commits][0]!
  }

  private async git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await this.run('git', args, { cwd: resolveHomePath(cwd), timeoutMs: 120_000, env: env ?? this.env })
    if (result.code !== 0) throw new DeviceDomainError('command_failed', result.stderr.trim() || 'Could not prepare the selected branch checkout.')
    return result.stdout.trim()
  }
}
