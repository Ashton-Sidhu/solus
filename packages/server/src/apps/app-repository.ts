import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppRevisionStats } from '@solus/contracts/apps'
import { hostCliEnv } from '../cli-env'
import { dataDir } from '../platform/paths'
import { withUserScope } from '../vault/acting-scope'

/**
 * An app's git repository (docs/plans/apps.md §4.2): a private, bare
 * repository under the host's data folder, as a work's history is
 * (`sync/git-storage/local-git-repository-provider.ts`). `refs/heads/main` is the source:
 * one commit, a revision, for each save. `refs/solus/versions/<number>` is the
 * build of that version: one commit whose parent is the revision it was built
 * from. The host writes every commit; nothing pushes to this repository.
 */

/** One file of a commit: a path with `/` separators, relative to the root. */
export interface AppFile {
  path: string
  bytes: Buffer
}

/** One revision as the repository has it. */
export interface AppRevision {
  commit: string
  message: string
  savedAt: number
  stats: AppRevisionStats
}

/** What a save wrote. */
export interface AppSavedRevision {
  commit: string
  /** The revision before it; null for the first one. */
  parent: string | null
  /** The paths the revision before it had and this one does not. */
  removed: string[]
}

/** A save started from a revision that is not the app's newest (decision 7). */
export class AppRevisionConflict extends Error {
  constructor(readonly newest: string | null) {
    super('The app has a newer revision.')
    this.name = 'AppRevisionConflict'
  }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_PATCH_BYTES = 512 * 1024
const COMMIT = /^[a-f0-9]{40}$/

/** The counts of git's `--shortstat` line: ` 3 files changed, 10 insertions(+), 2 deletions(-)`. No line is a revision that changed nothing. */
export function revisionStats(shortstat: string): AppRevisionStats {
  const count = (pattern: RegExp) => Number(pattern.exec(shortstat)?.[1] ?? 0)
  return { files: count(/(\d+) files? changed/), additions: count(/(\d+) insertions?\(\+\)/), deletions: count(/(\d+) deletions?\(-\)/) }
}

function assertCommit(commit: string): void {
  if (!COMMIT.test(commit)) throw new Error('Invalid app commit reference.')
}

/** A path a commit may hold: relative, with no empty, `.`, or `..` segment. */
function assertFilePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || segment === '.git')) {
    throw new Error(`An app file has a path a repository cannot hold: ${path}`)
  }
}

export class AppRepositories {
  constructor(private readonly root: () => string = () => join(dataDir(), 'apps', 'repositories')) {}

  /** The repository name of a new app. It never changes. */
  nameFor(organizationId: string, appId: string): string {
    return `app-${createHash('sha256').update(JSON.stringify([organizationId, appId])).digest('hex').slice(0, 48)}`
  }

  /** Where the repository is on this host: what a person clones. */
  path(repository: string): string {
    if (!/^app-[a-f0-9]{48}$/.test(repository)) throw new Error('Invalid app repository name.')
    return join(this.root(), `${repository}.git`)
  }

  private git(repository: string, args: string[], options: { input?: Buffer | string; env?: NodeJS.ProcessEnv; workTree?: string } = {}): Promise<Buffer> {
    // These are service-owned repositories, not a person's code checkout.
    return withUserScope(null, () => new Promise<Buffer>((resolve, reject) => {
      const env = hostCliEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...options.env })
      for (const key of Object.keys(env)) if (key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE') delete env[key]
      const child = execFile('git', [
        '--git-dir', this.path(repository), ...(options.workTree ? ['--work-tree', options.workTree] : []),
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args,
      ], { env, timeout: 60_000, maxBuffer: MAX_FILE_BYTES, encoding: 'buffer' }, (error, stdout) => {
        if (error) reject(new Error(`The app repository's git ${args[0]} failed.`))
        else resolve(stdout)
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.input)
    }))
  }

  private async text(repository: string, args: string[], options: Parameters<AppRepositories['git']>[2] = {}): Promise<string> {
    return (await this.git(repository, args, options)).toString('utf8').trim()
  }

  private async ensure(repository: string): Promise<void> {
    await mkdir(this.path(repository), { recursive: true, mode: 0o700 })
    await this.git(repository, ['init', '--bare', '--initial-branch=main'])
  }

  /** One commit from a set of files, on top of `parent`. Blobs and the tree are written with no checkout. */
  private async commit(repository: string, files: readonly AppFile[], parent: string | null, message: string, at: number): Promise<string> {
    const scratch = await mkdtemp(join(tmpdir(), 'solus-app-commit-'))
    try {
      const entries: string[] = []
      for (const file of files) {
        assertFilePath(file.path)
        const blob = await this.text(repository, ['hash-object', '-w', '--stdin'], { input: file.bytes })
        entries.push(`100644 ${blob}\t${file.path}\0`)
      }
      const index = { GIT_INDEX_FILE: join(scratch, 'index') }
      if (entries.length > 0) await this.git(repository, ['update-index', '-z', '--add', '--index-info'], { input: entries.join(''), env: index })
      const tree = entries.length > 0 ? await this.text(repository, ['write-tree'], { env: index }) : EMPTY_TREE
      const date = new Date(at).toISOString()
      return await this.text(repository, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], {
        env: {
          GIT_AUTHOR_NAME: 'Solus', GIT_AUTHOR_EMAIL: 'apps@solus.invalid', GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: 'Solus', GIT_COMMITTER_EMAIL: 'apps@solus.invalid', GIT_COMMITTER_DATE: date,
        },
      })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /** The newest revision; null for a repository with no save. */
  async head(repository: string): Promise<string | null> {
    const commit = await this.text(repository, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']).catch(() => '')
    return COMMIT.test(commit) ? commit : null
  }

  /**
   * Writes one revision on top of the newest one and moves `main` to it.
   * `expected` is the revision the source came from: when the app has another
   * newest revision now, nothing is written (decision 7).
   */
  async saveRevision(repository: string, revision: { source: readonly AppFile[]; message: string; at: number; expected: string | null }): Promise<AppSavedRevision> {
    await this.ensure(repository)
    const parent = await this.head(repository)
    if (parent !== revision.expected) throw new AppRevisionConflict(parent)
    const commit = await this.commit(repository, revision.source, parent, revision.message, revision.at)
    // The ref moves only from the parent this save read: a save that ran at the same time loses here.
    await this.git(repository, ['update-ref', 'refs/heads/main', commit, parent ?? '']).catch(() => {
      throw new AppRevisionConflict(null)
    })
    const removed = parent
      ? (await this.git(repository, ['diff', '--no-renames', '--diff-filter=D', '--name-only', '-z', parent, commit])).toString('utf8').split('\0').filter(Boolean)
      : []
    return { commit, parent, removed }
  }

  /** Writes the build of one version: one commit on top of the revision it was built from, under `refs/solus/versions/<number>`. */
  async commitBuild(repository: string, build: { number: number; revision: string; files: readonly AppFile[]; at: number }): Promise<string> {
    assertCommit(build.revision)
    const buildCommit = await this.commit(repository, build.files, build.revision, `Build of version ${build.number}`, build.at)
    await this.git(repository, ['update-ref', `refs/solus/versions/${build.number}`, buildCommit])
    return buildCommit
  }

  /** Whether the repository has this revision on `main`. */
  async hasRevision(repository: string, commit: string): Promise<boolean> {
    assertCommit(commit)
    return this.git(repository, ['merge-base', '--is-ancestor', commit, 'refs/heads/main']).then(() => true, () => false)
  }

  /** The revisions, the newest first, each with how much it changed against the revision before it. */
  async revisions(repository: string, limit = 100): Promise<AppRevision[]> {
    if (!(await this.head(repository))) return []
    // `--shortstat` writes its line after the commit's own line; a revision that changed nothing has none.
    const listed = await this.text(repository, ['log', `--max-count=${limit}`, '--shortstat', '--format=%x1e%H%x1f%ct%x1f%s', 'refs/heads/main'])
    return listed.split('\x1e').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const [line = '', ...rest] = entry.split('\n')
      const [commit = '', seconds = '0', message = ''] = line.split('\x1f')
      return { commit, message, savedAt: Number(seconds) * 1000, stats: revisionStats(rest.join(' ')) }
    })
  }

  /** The revision before one; null for the first. */
  async parentOf(repository: string, commit: string): Promise<string | null> {
    assertCommit(commit)
    const parent = await this.text(repository, ['rev-parse', '--verify', '--quiet', `${commit}^`]).catch(() => '')
    return COMMIT.test(parent) ? parent : null
  }

  /** One file of a commit; null when the commit has no such file. */
  async readFile(repository: string, commit: string, path: string): Promise<Buffer | null> {
    assertCommit(commit)
    assertFilePath(path)
    return this.git(repository, ['show', `${commit}:${path}`]).catch(() => null)
  }

  async listFiles(repository: string, commit: string, folder = ''): Promise<string[]> {
    assertCommit(commit)
    if (folder) assertFilePath(folder)
    const listed = await this.git(repository, ['ls-tree', '-r', '-z', '--name-only', commit, ...(folder ? ['--', folder] : [])])
    return listed.toString('utf8').split('\0').filter(Boolean)
  }

  /** Writes the files of a commit into a folder. Files already there with other names stay. */
  async checkout(repository: string, commit: string, folder: string): Promise<number> {
    assertCommit(commit)
    await mkdir(folder, { recursive: true })
    const scratch = await mkdtemp(join(tmpdir(), 'solus-app-checkout-'))
    try {
      await this.git(repository, ['checkout', '-f', commit, '--', '.'], { workTree: folder, env: { GIT_INDEX_FILE: join(scratch, `index-${randomUUID()}`) } })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
    return (await this.listFiles(repository, commit)).length
  }

  /** The source change from one commit to another as a unified patch; `from: null` is the first revision. */
  async diff(repository: string, from: string | null, to: string): Promise<{ patch: string; truncated: boolean }> {
    if (from) assertCommit(from)
    assertCommit(to)
    const patch = await this.git(repository, ['diff', '--no-color', '--no-ext-diff', from ?? EMPTY_TREE, to])
    return { patch: patch.subarray(0, MAX_PATCH_BYTES).toString('utf8'), truncated: patch.length > MAX_PATCH_BYTES }
  }

  async remove(repository: string): Promise<void> {
    await rm(this.path(repository), { recursive: true, force: true })
  }
}
