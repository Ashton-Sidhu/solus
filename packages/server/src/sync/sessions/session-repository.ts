import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { GitRemote, type CheckedPushResult } from '../git-remote'
import { hostCliEnv } from '../../cli-env'
import { withUserScope } from '../../vault/acting-scope'
import { sessionManifestSchema, type SessionManifest, type SessionManifestThreadFile } from './session-manifest'

/**
 * The local copies of session repositories (docs/plans/portable-sessions.md §5
 * and §6.2): one bare repository for each session, under the Solus data
 * directory and never inside a project folder. Only Solus reads them, always
 * with `--git-dir` (ADR 0002). A turn commit is built from Git objects with no
 * checkout; file content goes to Git as a stream, so a large transcript is
 * never held in memory.
 */

const GIT_TIMEOUT_MS = 10 * 60_000
const MAX_TEXT_BYTES = 16 * 1024 * 1024
const ZERO_SHA = '0'.repeat(40)

/** A work builds `work-<48 hex>` the same way (`data/works/work-storage.ts`). */
export function sessionRepositoryName(organizationId: string, sessionId: string): string {
  return `session-${createHash('sha256').update(JSON.stringify([organizationId, sessionId])).digest('hex').slice(0, 48)}`
}

/** One file of a turn commit: text, a whole file, or the bytes `[from, to)` of a file. */
export type TurnCommitEntry =
  | { path: string; content: string }
  | { path: string; file: string; from?: number; to?: number }

export interface TurnCommit {
  /** The head this commit continues; null for the first commit. */
  expectedHead: string | null
  message: string
  entries: TurnCommitEntry[]
}

/** What one Git process reads and where its output goes; with no `output`, the output is the answer. */
interface GitIo {
  text?: string
  stream?: Readable
  output?: Writable
  env?: NodeJS.ProcessEnv
}

/** Another writer moved the head after the caller read it. */
export class SessionHeadMovedError extends Error {
  constructor() {
    super('The session repository changed before this commit.')
  }
}

/** The incoming repository does not continue this copy's head. */
export class SessionBundleDivergedError extends Error {
  constructor() { super('The session bundle is not a fast-forward of the local head.') }
}

/** The local copies under one folder. It alone knows where a copy is on disk. */
export class SessionRepositories {
  constructor(private readonly root: string) {}

  /** The local copy with this name. `signal` stops the Git processes of this copy. */
  named(name: string, signal?: AbortSignal): SessionRepository {
    if (!/^session-[a-f0-9]{48}$/.test(name)) throw new Error('Invalid session repository name.')
    return new SessionRepository(join(this.root, `${name}.git`), signal)
  }
}

/** One local copy of a session repository. It can be absent on disk: it then has no head, and a commit or a fetch makes it. */
export class SessionRepository {
  /** `path` is the bare Git directory. */
  constructor(readonly path: string, private readonly signal?: AbortSignal) {}

  private git(args: string[], io: GitIo = {}): Promise<string> {
    return withUserScope(null, () => new Promise<string>((resolve, reject) => {
      const env = hostCliEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...io.env })
      for (const key of Object.keys(env)) if (key.startsWith('GIT_TRACE')) delete env[key]
      const child = spawn('git', ['--git-dir', this.path, '-c', 'core.hooksPath=/dev/null', ...args], {
        env, signal: this.signal, timeout: GIT_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'ignore'],
      })
      const parts: Buffer[] = []
      let bytes = 0
      if (io.output) child.stdout.pipe(io.output, { end: false })
      else child.stdout.on('data', (part: Buffer) => { bytes += part.length; if (bytes > MAX_TEXT_BYTES) child.kill(); else parts.push(part) })
      child.stdin.on('error', () => {})
      if (io.stream) {
        io.stream.on('error', () => child.kill())
        io.stream.pipe(child.stdin)
      } else child.stdin.end(io.text)
      child.once('error', () => reject(new Error('The session repository Git process could not run.')))
      child.once('close', (code) => {
        if (code === 0) resolve(Buffer.concat(parts).toString('utf8').trim())
        else reject(new Error(`The session repository Git ${args[0]} operation failed (${code}).`))
      })
    }))
  }

  private async init(): Promise<void> {
    await mkdir(this.path, { recursive: true, mode: 0o700 })
    await this.git(['init', '--bare', '--initial-branch=main'])
  }

  /** The newest turn commit, or null for a repository with none. */
  async head(): Promise<string | null> {
    return this.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).catch(() => null)
  }

  async readText(commit: string, path: string): Promise<string> {
    return this.git(['cat-file', 'blob', `${commit}:${checkedPath(path)}`])
  }

  /** The manifest of `commit`, including phase-1 manifests with absent sync fields. */
  async readManifest(commit: string): Promise<SessionManifest> {
    return sessionManifestSchema.parse(JSON.parse(await this.readText(commit, 'manifest.json')))
  }

  /** Write a provider file by joining its byte ranges in manifest order. */
  async writeThreadFile(commit: string, threadId: string, file: SessionManifestThreadFile, outFile: string): Promise<void> {
    await rm(outFile, { force: true })
    await this.appendFiles(commit, file.parts.map((part) => `threads/${threadId}/${file.key}/${part}`), outFile)
  }

  /** Write commits after `have`; a divergent `have` gets no bundle. */
  async bundleSince(have: string | null, outFile: string): Promise<{ kind: 'written'; head: string } | { kind: 'current'; head: string | null } | { kind: 'diverged'; head: string | null }> {
    if (!isAbsolute(outFile)) throw new Error('The session bundle path must be absolute.')
    if (have && !/^[a-f0-9]{40}$/.test(have)) throw new Error('Invalid session repository head.')
    const head = await this.head()
    if (!head || head === have) return { kind: 'current', head }
    if (have) {
      const isAncestor = await this.git(['merge-base', '--is-ancestor', have, head]).then(() => true, () => false)
      if (!isAncestor) return { kind: 'diverged', head }
    }
    await this.git(['bundle', 'create', outFile, 'refs/heads/main', ...(have ? [`^${have}`] : [])])
    return { kind: 'written', head }
  }

  /** Import a bundle only when its main continues the local main. */
  async fetchBundle(bundleFile: string, preserveLocalHead = false): Promise<string> {
    const localHead = await this.head()
    const staging = new SessionRepository(join(dirname(this.path), `${sessionRepositoryName('staging', randomUUID())}.git`), this.signal)
    try {
      await staging.init()
      if (localHead) {
        await mkdir(join(staging.path, 'objects', 'info'), { recursive: true })
        await writeFile(join(staging.path, 'objects', 'info', 'alternates'), `${join(this.path, 'objects')}\n`)
      }
      await staging.git(['fetch', bundleFile, 'refs/heads/main'])
      const incomingHead = await staging.git(['rev-parse', 'FETCH_HEAD'])
      if (localHead && !preserveLocalHead) {
        const isAncestor = await staging.git(['merge-base', '--is-ancestor', localHead, incomingHead]).then(() => true, () => false)
        if (!isAncestor) throw new SessionBundleDivergedError()
      }
      if (!localHead) await this.init()
      await this.git(['fetch', bundleFile, 'refs/heads/main'])
      if (localHead && preserveLocalHead) await this.git(['update-ref', `refs/solus/refused/${localHead}`, localHead])
      await this.git(['update-ref', 'refs/heads/main', incomingHead, localHead ?? ZERO_SHA])
        .catch(() => { throw new SessionBundleDivergedError() })
      return incomingHead
    } finally {
      await rm(staging.path, { recursive: true, force: true })
    }
  }

  /** Push a fixed commit only when the remote still has the expected head. */
  async push(remote: string, commit: string, expectedHead: string | null, token?: string, signal?: AbortSignal): Promise<CheckedPushResult> {
    const git = await GitRemote.open({ gitDir: this.path, remote, token, signal, timeoutMs: 60 * 60_000 })
    try {
      const remoteHead = await git.remoteHead()
      if (remoteHead === commit) return { status: 'accepted', head: commit }
      if (remoteHead && remoteHead !== expectedHead) {
        const ancestor = await git.git(['merge-base', '--is-ancestor', remoteHead, commit]).then(() => true, () => false)
        if (!ancestor) return { status: 'refused', head: remoteHead }
      }
      return await git.checkedPush(commit, remoteHead)
    } finally { await git.close() }
  }

  /** Append the content of each path at `commit`, in order, to `outFile`. */
  async appendFiles(commit: string, paths: string[], outFile: string): Promise<void> {
    const output = createWriteStream(outFile, { flags: 'a' })
    try {
      for (const path of paths) await this.git(['cat-file', 'blob', `${commit}:${checkedPath(path)}`], { output })
    } finally {
      await new Promise<void>((resolve) => output.end(resolve))
    }
  }

  /** Write one commit on top of `expectedHead` and answer its id. */
  async commit(turn: TurnCommit): Promise<string> {
    await this.init()
    const head = await this.head()
    if (head !== turn.expectedHead) throw new SessionHeadMovedError()
    const index = join(this.path, `solus-index-${randomUUID()}`)
    const env = { GIT_INDEX_FILE: index }
    try {
      await this.git(head ? ['read-tree', head] : ['read-tree', '--empty'], { env })
      const lines: string[] = []
      for (const entry of turn.entries) {
        const blob = await this.git(['hash-object', '-w', '--stdin'], 'content' in entry ? { text: entry.content }
          // A stream cannot read an empty range.
          : entry.to !== undefined && entry.to <= (entry.from ?? 0) ? { text: '' }
            // A stream's `end` is the last byte it reads.
            : { stream: createReadStream(entry.file, { start: entry.from ?? 0, end: entry.to === undefined ? Infinity : entry.to - 1 }) })
        lines.push(`100644 ${blob}\t${checkedPath(entry.path)}\n`)
      }
      await this.git(['update-index', '--index-info'], { env, text: lines.join('') })
      const tree = await this.git(['write-tree'], { env })
      const commit = await this.git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', turn.message], {
        env: { GIT_AUTHOR_NAME: 'Solus', GIT_AUTHOR_EMAIL: 'storage@solus.invalid', GIT_COMMITTER_NAME: 'Solus', GIT_COMMITTER_EMAIL: 'storage@solus.invalid' },
      })
      // Git moves the ref only from the head this commit was built on.
      await this.git(['update-ref', 'refs/heads/main', commit, head ?? ZERO_SHA]).catch(() => { throw new SessionHeadMovedError() })
      return commit
    } finally {
      await rm(index, { force: true })
    }
  }
}

/** A path inside a session repository: plain segments only, so no entry can leave its folder. */
function checkedPath(path: string): string {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path) || path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Invalid session repository path.')
  }
  return path
}
