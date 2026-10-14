import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveHomePath } from '../platform/paths'
import { DeviceDomainError } from './device-errors'
import type { DeviceCommandRunner } from './device-process'

/** A checkout Solus owns, moved to the newest commit of its source on each run. */
export class DeviceRunSources {
  constructor(private readonly root: string, private readonly run: DeviceCommandRunner) {}

  async prepare(project: string, source: 'main' | 'conversation' = 'main', branch?: string): Promise<{ path: string; commit: string; hasChangedCommit: boolean }> {
    const directory = join(this.root, createHash('sha256').update(`${project}\u0000${branch ?? source}`).digest('hex').slice(0, 24))
    const path = join(directory, 'checkout')
    const lastCommitPath = join(directory, 'commit')
    await mkdir(directory, { recursive: true })
    const previous = await readFile(lastCommitPath, 'utf8').catch(() => null)
    const commit = branch ? await this.branchCommit(project, branch) : await this.git(project, ['rev-parse', '--verify', source === 'main' ? 'refs/heads/main^{commit}' : 'HEAD^{commit}'])
    if (!/^[a-f0-9]{40,64}$/.test(commit.trim())) throw new DeviceDomainError('invalid_request', 'The selected branch has no commit. Choose another branch.')
    if (!(await stat(join(path, '.git')).catch(() => null))) {
      await this.git(directory, ['clone', '--no-hardlinks', '--no-checkout', '--', project, path])
    }
    const known = await this.run('git', ['cat-file', '-e', `${commit.trim()}^{commit}`], { cwd: resolveHomePath(path), timeoutMs: 10_000 })
    if (known.code !== 0) await this.git(path, ['fetch', '--no-tags', 'origin', commit.trim()])
    await this.git(path, ['checkout', '--force', '--detach', commit.trim()])
    await writeFile(lastCommitPath, commit.trim(), { mode: 0o600 })
    return { path, commit: commit.trim(), hasChangedCommit: previous !== commit.trim() }
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

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await this.run('git', args, { cwd: resolveHomePath(cwd), timeoutMs: 120_000 })
    if (result.code !== 0) throw new DeviceDomainError('command_failed', result.stderr.trim() || 'Could not prepare the selected branch checkout.')
    return result.stdout.trim()
  }
}
