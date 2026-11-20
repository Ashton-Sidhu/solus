import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { hostCliEnv } from '../../cli-env'
import { isStorageRepositoryName, type StorageRepositoryKind } from '../../data/storage-repository-name'
import { GitProcessError, runGit, type GitPolicy } from '../../git/git-process'

/**
 * The Git storage layer (docs/adr/0004-shared-git-storage.md): the bare
 * repositories that keep the history of works and of sessions. Only Solus
 * reads them, always with `--git-dir` (ADR 0002), and never with a checkout.
 * This file owns the storage policy of the Git process runner
 * (docs/adr/0005-one-git-process-runner.md), and no other file uses it.
 */

const MAX_TEXT_BYTES = 16 * 1024 * 1024
const ZERO_SHA = '0'.repeat(40)
const COMMIT = /^[a-f0-9]{40}$/

export interface GitRepositoryOptions {
  /** Stops each Git process of this repository. */
  signal?: AbortSignal
  /** The time limit of one Git process. */
  timeoutMs?: number
  /** The time limit of all the work on one remote. A process that it stops answers "The Git operation timed out." */
  deadline?: AbortSignal
  /** The limit of the text that one Git process answers with. The default is 16 MiB. */
  outputLimitBytes?: number
  /** Added to the environment of each Git process: the credential and the settings of a remote. */
  env?: NodeJS.ProcessEnv
  /** Names the repository in the error of a failed Git process, for example `session repository`. */
  subject?: string
}

/** What one Git process reads and where its output goes; with no `output`, the output is the answer. */
export interface GitIo {
  text?: string
  stream?: Readable
  output?: Writable
  env?: NodeJS.ProcessEnv
  /** The limit of a file read. More output gives `RepositoryFileTooLargeError`. */
  maxBytes?: number
}

/** New content of one file: text, a whole file on disk, or the bytes `[from, to)` of a file on disk. */
export type GitFileContent =
  | { content: string }
  | { file: string; from?: number; to?: number }

/** One file of a commit. A `blob` entry names an object that can be in the remote only. */
export type GitFileEntry = { path: string } & GitFileContent
export type GitCommitEntry = GitFileEntry | { path: string; blob: string }

export interface GitCommit {
  /** The commit that this one continues; null for the first commit. */
  parent: string | null
  message: string
  entries: GitCommitEntry[]
  /** True: the files of the parent stay, and the entries add to them. False: the entries are the whole tree. */
  keepParentFiles: boolean
  /** The author and committer date. A retry with the same date and input gives the same commit. */
  date?: string
}

/** A file is larger than the limit that its reader gave. */
export class RepositoryFileTooLargeError extends Error {
  constructor() { super('The repository file is larger than the read limit.') }
}

/** Where the repository `name` of one feature is in the folder `root`. */
export function repositoryPath(root: string, kind: StorageRepositoryKind, name: string): string {
  if (!isStorageRepositoryName(name, kind)) throw new Error(`Invalid ${kind} repository name.`)
  return join(root, `${name}.git`)
}

/**
 * The storage policy: Git on a repository that Solus owns. The host runs it,
 * with no system config, no global config, no prompt, and no hook, and each
 * command names the repository with `--git-dir`.
 */
function storagePolicy(gitDir: string, options: GitRepositoryOptions): GitPolicy {
  const name = options.subject ? `${options.subject} Git` : 'Git'
  return {
    name: 'storage',
    args: ['--git-dir', gitDir, '-c', 'core.hooksPath=/dev/null'],
    // Git diagnostics can contain the credential, so nothing reads them.
    keepsOutput: false,
    // These are service-owned repositories, not a person's code checkout: the host runs Git, with no user of a member.
    launchOptions(_args, env) {
      const hostEnv = hostCliEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...options.env, ...env })
      // A trace can contain the credential of a remote.
      for (const key of Object.keys(hostEnv)) if (key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE') delete hostEnv[key]
      return { env: hostEnv }
    },
    // A person can see these words, so they show no command and no diagnostics. A process that Solus stops has no exit code; the words then give 1.
    failureMessage(failure, args) {
      if (options.deadline?.aborted) return 'The Git operation timed out.'
      return failure.reason === 'not-started' ? `The ${name} process could not run.` : `The ${name} ${args[0]} operation failed (${failure.code ?? 1}).`
    },
  }
}

/** One bare repository on disk. It can be absent: it then has no head, and `init` makes it. */
export class GitRepository {
  private readonly policy: GitPolicy

  /** `path` is the bare Git directory. */
  constructor(readonly path: string, protected readonly options: GitRepositoryOptions = {}) {
    this.policy = storagePolicy(path, options)
  }

  /** Run one Git command in this repository and answer its output. A failure is a `GitProcessError`. */
  git(args: string[], io: GitIo = {}): Promise<string> {
    const { signal, deadline } = this.options
    return runGit(this.policy, args, {
      env: io.env,
      signal: signal && deadline ? AbortSignal.any([signal, deadline]) : signal ?? deadline,
      timeout: this.options.timeoutMs,
      outputLimit: io.maxBytes ?? this.options.outputLimitBytes ?? MAX_TEXT_BYTES,
      input: io.stream ?? io.text,
      output: io.output,
    }).then((output) => output.toString('utf8'), (error: Error) => {
      throw io.maxBytes !== undefined && error instanceof GitProcessError && error.reason === 'output-limit' ? new RepositoryFileTooLargeError() : error
    })
  }

  /** Make the repository. It is safe on a repository that exists. */
  async init(): Promise<void> {
    await mkdir(this.path, { recursive: true, mode: 0o700 })
    await this.git(['init', '--bare', '--initial-branch=main'])
  }

  /** The newest commit of `main`, or null for a repository with none. */
  async head(): Promise<string | null> {
    return this.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).then((head) => head.trim(), () => null)
  }

  /** Move `main` to `commit`. With `expected`, Git moves it only from that head; null is a repository with no head. */
  async setHead(commit: string, expected?: string | null): Promise<void> {
    await this.git(['update-ref', 'refs/heads/main', commit, ...(expected === undefined ? [] : [expected ?? ZERO_SHA])])
  }

  async isAncestor(ancestor: string, commit: string): Promise<boolean> {
    return this.git(['merge-base', '--is-ancestor', ancestor, commit]).then(() => true, () => false)
  }

  /** Fetch `main` of a remote URL or of a bundle file; the result is `FETCH_HEAD`. With a filter, Git gets a blob from the source only when a command reads it. */
  async fetchMain(source: string, filter?: 'blob:none'): Promise<void> {
    await this.git(['fetch', ...(filter ? [`--filter=${filter}`] : []), source, 'refs/heads/main'])
  }

  /** Read the objects of another local repository in place, so a fetch gets only the objects that are new. */
  async borrowObjects(repositoryPath: string): Promise<void> {
    await mkdir(join(this.path, 'objects', 'info'), { recursive: true })
    await writeFile(join(this.path, 'objects', 'info', 'alternates'), `${join(repositoryPath, 'objects')}\n`)
  }

  /** The content of one file at `commit`. More than `maxBytes` gives `RepositoryFileTooLargeError`. */
  async readText(commit: string, path: string, maxBytes?: number): Promise<string> {
    return this.git(['cat-file', 'blob', blobAt(commit, path)], { maxBytes })
  }

  /** Append the content of each path at `commit`, in order, to `outFile`. */
  async appendFiles(commit: string, paths: string[], outFile: string): Promise<void> {
    const output = createWriteStream(outFile, { flags: 'a' })
    try {
      for (const path of paths) await this.git(['cat-file', 'blob', blobAt(commit, path)], { output })
    } finally {
      await new Promise<void>((resolve) => output.end(resolve))
    }
  }

  /** Write one blob and answer its id. A file goes to Git as a stream, so a large file is never held in memory. */
  async writeBlob(source: GitFileContent): Promise<string> {
    const io: GitIo = 'content' in source ? { text: source.content }
      // A stream cannot read an empty range.
      : source.to !== undefined && source.to <= (source.from ?? 0) ? { text: '' }
        // A stream's `end` is the last byte it reads.
        : { stream: createReadStream(source.file, { start: source.from ?? 0, end: source.to === undefined ? Infinity : source.to - 1 }) }
    return (await this.git(['hash-object', '-w', '--stdin'], io)).trim()
  }

  /** Write one commit from Git objects, with no checkout, and answer its id. It moves no ref. */
  async writeCommit(commit: GitCommit): Promise<string> {
    const index = join(this.path, `solus-index-${randomUUID()}`)
    const env = { GIT_INDEX_FILE: index }
    try {
      await this.git(commit.parent && commit.keepParentFiles ? ['read-tree', commit.parent] : ['read-tree', '--empty'], { env })
      const lines: string[] = []
      for (const entry of commit.entries) {
        lines.push(`100644 ${'blob' in entry ? entry.blob : await this.writeBlob(entry)}\t${checkedPath(entry.path)}\n`)
      }
      await this.git(['update-index', '--index-info'], { env, text: lines.join('') })
      // Git cannot check a blob that only the remote has.
      const namesBlob = commit.entries.some((entry) => 'blob' in entry)
      const tree = (await this.git(['write-tree', ...(namesBlob ? ['--missing-ok'] : [])], { env })).trim()
      return (await this.git(['commit-tree', tree, ...(commit.parent ? ['-p', commit.parent] : []), '-m', commit.message], {
        env: {
          GIT_AUTHOR_NAME: 'Solus', GIT_AUTHOR_EMAIL: 'storage@solus.invalid', GIT_AUTHOR_DATE: commit.date,
          GIT_COMMITTER_NAME: 'Solus', GIT_COMMITTER_EMAIL: 'storage@solus.invalid', GIT_COMMITTER_DATE: commit.date,
        },
      })).trim()
    } finally {
      await rm(index, { force: true })
    }
  }
}

function blobAt(commit: string, path: string): string {
  if (!COMMIT.test(commit)) throw new Error('Invalid repository commit.')
  return `${commit}:${checkedPath(path)}`
}

/** A path inside a storage repository: plain segments only, so no entry can leave its folder. */
function checkedPath(path: string): string {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path) || path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Invalid repository path.')
  }
  return path
}
