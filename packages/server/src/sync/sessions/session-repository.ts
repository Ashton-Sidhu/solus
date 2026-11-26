import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { storageRepositoryName } from '../../data/storage-repository-name'
import { GitRemote, type CheckedPushResult } from '../git-storage/git-remote'
import { GitRepository, repositoryPath, type GitFileEntry } from '../git-storage/git-repository'
import { sessionManifestSchema, type SessionManifest, type SessionManifestThreadFile } from './session-manifest'

/**
 * The local copies of session repositories (docs/plans/portable-sessions.md §5
 * and §6.2): one bare repository for each session, under the Solus data
 * directory and never inside a project folder. The Git commands are those of
 * the Git storage layer (docs/adr/0004-shared-git-storage.md); this file owns
 * the name of a local copy, the files of a turn commit, the code bundles, and
 * the bundle that two hosts exchange.
 *
 * A code bundle is not a file of `main` (docs/plans/session-storage.md §4). Each
 * one is the file `bundle` of a commit with no parent under `codeRef(sha256)`.
 * The ref keeps the object, and a push of `main` never sends it.
 */

/** A session blob can be a large transcript or a code bundle. */
const GIT_TIMEOUT_MS = 10 * 60_000

/** The name of the local copy on a host. The cloud copy has another name (`cloudSessionRepositoryName`). */
export function sessionRepositoryName(organizationId: string, sessionId: string): string {
  return storageRepositoryName('session', organizationId, sessionId)
}

const CODE_REFS = 'refs/solus/code/'

/** The ref of the code bundle with this SHA-256. */
export function codeRef(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid code bundle hash.')
  return `${CODE_REFS}${sha256}`
}
/** One date for each code commit, so that the same bundle gives the same commit on each host. */
const CODE_COMMIT_DATE = '@1000000000 +0000'

/** The SHA-256 and the size of a file, read as a stream. */
export async function fileDigest(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return { sha256: hash.digest('hex'), bytes: (await stat(path)).size }
}

/** The SHA-256 of each stored code bundle in `manifest`. */
function storedBundles(manifest: SessionManifest | null): Set<string> {
  return new Set((manifest?.turns ?? []).flatMap((turn) => turn.bundle?.kind === 'stored' ? [turn.bundle.sha256] : []))
}

export interface TurnCommit {
  /** The head this commit continues; null for the first commit. */
  expectedHead: string | null
  message: string
  entries: GitFileEntry[]
  /** Commits that go before this one, in order, with one move of the head: a turn too large for one commit. */
  earlier?: Array<{ message: string; entries: GitFileEntry[] }>
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

  /** Write commits after `have`, with the code refs of the turns after `have`; a divergent `have` gets no bundle. */
  async bundleSince(have: string | null, outFile: string): Promise<{ kind: 'written'; head: string } | { kind: 'current'; head: string | null } | { kind: 'diverged'; head: string | null }> {
    if (!isAbsolute(outFile)) throw new Error('The session bundle path must be absolute.')
    if (have && !/^[a-f0-9]{40}$/.test(have)) throw new Error('Invalid session repository head.')
    const head = await this.head()
    if (!head || head === have) return { kind: 'current', head }
    if (have && !await this.isAncestor(have, head)) return { kind: 'diverged', head }
    // A head with no manifest that this release reads has no code ref to send; the reader refuses that head.
    const known = storedBundles(have ? await this.readManifest(have).catch(() => null) : null)
    const present = new Set((await this.git(['for-each-ref', '--format=%(refname)', CODE_REFS])).split('\n').filter(Boolean))
    const codeRefs = [...storedBundles(await this.readManifest(head).catch(() => null))].filter((sha256) => !known.has(sha256)).map(codeRef).filter((ref) => present.has(ref))
    await this.git(['bundle', 'create', outFile, 'refs/heads/main', ...codeRefs, ...(have ? [`^${have}`] : [])])
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
      // A source with no code ref fetches none.
      await this.git(['fetch', bundleFile, `+${CODE_REFS}*:${CODE_REFS}*`])
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
      // A push whose answer was lost: the remote has this commit and later commits of the local history.
      const localHead = await this.head()
      if (remoteHead && localHead && await this.isAncestor(commit, remoteHead) && await this.isAncestor(remoteHead, localHead)) return { status: 'accepted', head: remoteHead }
      if (remoteHead && remoteHead !== expectedHead && !await git.repository.isAncestor(remoteHead, commit)) return { status: 'refused', head: remoteHead }
      return await git.checkedPush(commit, remoteHead)
    } finally { await git.close() }
  }

  /** Write the commits of one turn on top of `expectedHead` and answer the id of the last. */
  async commit(turn: TurnCommit): Promise<string> {
    await this.init()
    const head = await this.head()
    if (head !== turn.expectedHead) throw new SessionHeadMovedError()
    let commit = head
    for (const step of [...turn.earlier ?? [], turn]) {
      commit = await this.writeCommit({ parent: commit, message: step.message, entries: step.entries, keepParentFiles: true })
    }
    // Git moves the ref only from the head this commit was built on.
    await this.setHead(commit!, head).catch(() => { throw new SessionHeadMovedError() })
    return commit!
  }

  /** Keep the code bundle `file` under its code ref and answer its facts. It is safe to repeat. */
  async storeCodeBundle(file: string): Promise<{ sha256: string; bytes: number }> {
    const digest = await fileDigest(file)
    await this.init()
    const commit = await this.writeCommit({ parent: null, message: `Solus code bundle ${digest.sha256}`, entries: [{ path: 'bundle', file }],
      keepParentFiles: false, date: CODE_COMMIT_DATE })
    await this.git(['update-ref', codeRef(digest.sha256), commit])
    return digest
  }

  async hasCodeBundle(sha256: string): Promise<boolean> {
    return this.git(['rev-parse', '--verify', '--quiet', codeRef(sha256)]).then(() => true, () => false)
  }

  /** Write the code bundle with this SHA-256 to `outFile`. */
  async writeCodeBundle(sha256: string, outFile: string): Promise<void> {
    const output = createWriteStream(outFile)
    try {
      await this.git(['cat-file', 'blob', `${codeRef(sha256)}:bundle`], { output })
    } finally {
      await new Promise<void>((resolve) => output.end(resolve))
    }
  }

  /** The commits after `from` through `to`, oldest first. */
  async commitsAfter(from: string | null, to: string): Promise<string[]> {
    return (await this.git(['rev-list', '--reverse', to, ...(from ? [`^${from}`] : [])])).split('\n').filter(Boolean)
  }

  /** The size of the objects that `to` has and `from` does not have, before compression. */
  async newObjectBytes(from: string | null, to: string): Promise<number> {
    const objects = await this.git(['rev-list', '--objects', '--no-object-names', to, ...(from ? [`^${from}`] : [])])
    if (!objects.trim()) return 0
    const sizes = await this.git(['cat-file', '--batch-check=%(objectsize)'], { input: objects })
    return sizes.split('\n').filter(Boolean).reduce((sum, size) => sum + Number(size), 0)
  }

  /** The code bundles that the manifest of `commit` adds, and whether `commit` writes a manifest. */
  async manifestChange(commit: string): Promise<{ writesManifest: boolean; addedBundles: Array<{ sha256: string; bytes: number }> }> {
    const parent = await this.git(['rev-parse', '--verify', '--quiet', `${commit}^`]).then((sha) => sha.trim(), () => null)
    const [blob, parentBlob] = await Promise.all([commit, parent].map((sha) => sha
      ? this.git(['rev-parse', '--verify', '--quiet', `${sha}:manifest.json`]).then((id) => id.trim(), () => null) : null))
    if (!blob || blob === parentBlob) return { writesManifest: false, addedBundles: [] }
    const known = storedBundles(parent && parentBlob ? await this.readManifest(parent) : null)
    const addedBundles = new Map<string, { sha256: string; bytes: number }>()
    for (const turn of (await this.readManifest(commit)).turns) {
      if (turn.bundle?.kind === 'stored' && !known.has(turn.bundle.sha256)) addedBundles.set(turn.bundle.sha256, { sha256: turn.bundle.sha256, bytes: turn.bundle.bytes })
    }
    return { writesManifest: true, addedBundles: [...addedBundles.values()] }
  }

  /** The schema version of the oldest manifest of `main`; null with none. */
  async firstManifestVersion(): Promise<number | null> {
    const first = (await this.git(['rev-list', '--reverse', 'refs/heads/main', '--', 'manifest.json']).catch(() => '')).split('\n')[0]
    return first ? (await this.readManifest(first)).schemaVersion : null
  }
}
