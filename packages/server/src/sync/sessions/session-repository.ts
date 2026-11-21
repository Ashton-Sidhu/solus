import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { storageRepositoryName } from '../../data/storage-repository-name'
import { GitRemote, type CheckedPushResult } from '../git-storage/git-remote'
import { GitRepository, repositoryPath, type GitFileEntry } from '../git-storage/git-repository'
import { sessionManifestSchema, type SessionManifest, type SessionManifestThreadFile } from './session-manifest'

/**
 * The local copies of session repositories (docs/plans/portable-sessions.md §5
 * and §6.2): one bare repository for each session, under the Solus data
 * directory and never inside a project folder. The Git commands are those of
 * the Git storage layer (docs/adr/0004-shared-git-storage.md); this file owns
 * the name of a local copy, the files of a turn commit, and the bundle that
 * two hosts exchange.
 */

/** A session blob can be a large transcript or a code bundle. */
const GIT_TIMEOUT_MS = 10 * 60_000

/** The name of the local copy on a host. The cloud copy has another name (`cloudSessionRepositoryName`). */
export function sessionRepositoryName(organizationId: string, sessionId: string): string {
  return storageRepositoryName('session', organizationId, sessionId)
}

export interface TurnCommit {
  /** The head this commit continues; null for the first commit. */
  expectedHead: string | null
  message: string
  entries: GitFileEntry[]
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
    return new SessionRepository(repositoryPath(this.root, 'session', name), signal)
  }
}

/** One local copy of a session repository. It can be absent on disk: it then has no head, and a commit or a fetch makes it. */
export class SessionRepository extends GitRepository {
  /** `path` is the bare Git directory. */
  constructor(path: string, signal?: AbortSignal) {
    super(path, { signal, timeoutMs: GIT_TIMEOUT_MS, subject: 'session repository' })
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
    if (have && !await this.isAncestor(have, head)) return { kind: 'diverged', head }
    await this.git(['bundle', 'create', outFile, 'refs/heads/main', ...(have ? [`^${have}`] : [])])
    return { kind: 'written', head }
  }

  /** Import a bundle only when its main continues the local main. */
  async fetchBundle(bundleFile: string, preserveLocalHead = false): Promise<string> {
    const localHead = await this.head()
    const staging = new SessionRepository(join(dirname(this.path), `${sessionRepositoryName('staging', randomUUID())}.git`), this.options.signal)
    try {
      await staging.init()
      if (localHead) await staging.borrowObjects(this.path)
      await staging.fetchMain(bundleFile)
      const incomingHead = (await staging.git(['rev-parse', 'FETCH_HEAD'])).trim()
      if (localHead && !preserveLocalHead && !await staging.isAncestor(localHead, incomingHead)) throw new SessionBundleDivergedError()
      if (!localHead) await this.init()
      await this.fetchMain(bundleFile)
      if (localHead && preserveLocalHead) await this.git(['update-ref', `refs/solus/refused/${localHead}`, localHead])
      await this.setHead(incomingHead, localHead).catch(() => { throw new SessionBundleDivergedError() })
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
      if (remoteHead && remoteHead !== expectedHead && !await git.repository.isAncestor(remoteHead, commit)) return { status: 'refused', head: remoteHead }
      return await git.checkedPush(commit, remoteHead)
    } finally { await git.close() }
  }

  /** Write one commit on top of `expectedHead` and answer its id. */
  async commit(turn: TurnCommit): Promise<string> {
    await this.init()
    const head = await this.head()
    if (head !== turn.expectedHead) throw new SessionHeadMovedError()
    const commit = await this.writeCommit({ parent: head, message: turn.message, entries: turn.entries, keepParentFiles: true })
    // Git moves the ref only from the head this commit was built on.
    await this.setHead(commit, head).catch(() => { throw new SessionHeadMovedError() })
    return commit
  }
}
