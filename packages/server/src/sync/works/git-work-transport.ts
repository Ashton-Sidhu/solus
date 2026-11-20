import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitRemote } from '../git-storage/git-remote'
import type { GitRepository } from '../git-storage/git-repository'
import type { RepositoryProvider } from '../git-storage/repository-provider'
import { documentContentHash } from '../../docs/content-hash'
import { workArchiveManifestSchema, type WorkArchiveOperation, type WorkArchiveBody, type WorkArchiveTransport } from '../../data/works/git-work-storage'

/** What a work archive needs from the place that holds its repository. */
type WorkRepositoryAccess = Pick<RepositoryProvider, 'remote' | 'readFile' | 'remove'>

/**
 * The archive of one work in its repository: `manifest.json`, each body at
 * `bodies/<content hash>`, and the current body at `content.<extension>`. The
 * Git commands are those of the Git storage layer
 * (docs/adr/0004-shared-git-storage.md).
 */
export class GitWorkTransport implements WorkArchiveTransport {
  constructor(private readonly access: WorkRepositoryAccess, private readonly signal?: AbortSignal) {}

  async read(repository: string, commit: string, hash: string): Promise<string> {
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid archived body reference.')
    const content = await this.access.readFile(repository, commit, `bodies/${hash}`)
    if (documentContentHash(content) !== hash) throw new Error('The archived body hash does not match.')
    return content
  }

  async remove(repository: string): Promise<void> {
    try { await this.access.remove(repository) } catch { throw new Error('The work archive could not be deleted; cleanup will retry.') }
  }

  /** The record service has no local copy of an archive: it fetches the head with no blobs, adds one commit, and pushes it. */
  async push(repository: string, operation: WorkArchiveOperation, bodies: readonly WorkArchiveBody[]): Promise<string> {
    const remote = await this.access.remote(repository, 'write')
    const root = await mkdtemp(join(tmpdir(), 'solus-work-archive-'))
    const client = await GitRemote.open({ gitDir: root, remote: remote.url, token: remote.token,
      signal: this.signal, timeoutMs: 120_000, outputLimitBytes: 16 * 1024 * 1024 })
    try {
      const scratch = client.repository
      await scratch.init()
      await scratch.git(['config', 'remote.origin.promisor', 'true'])
      await scratch.git(['config', 'remote.origin.partialclonefilter', 'blob:none'])
      const head = await client.remoteHead()
      if (head) await scratch.fetchMain(remote.url, 'blob:none')
      if (head) {
        const current = workArchiveManifestSchema.parse(JSON.parse(await scratch.readText(head, 'manifest.json')))
        if (current.operationId === operation.manifest.operationId) {
          if (JSON.stringify(current) !== JSON.stringify(operation.manifest)) throw new Error('The remote operation differs from the pending write.')
          return head
        }
        if (current.work.id !== operation.manifest.work.id || current.work.organizationId !== operation.manifest.work.organizationId) throw new Error('The archive belongs to another work.')
      }
      if (head !== operation.expectedCommit) throw new Error('The remote work changed before this push.')
      const commit = await writeArchiveCommit(scratch, head, operation, bodies)
      await scratch.setHead(commit)
      const pushed = await client.checkedPush(commit, head)
      if (pushed.status === 'refused') throw new Error('The remote work changed before this push.')
      if (pushed.status === 'failed') throw new Error('The archive push was not confirmed.')
      return commit
    } finally { await client.close(); await rm(root, { recursive: true, force: true }) }
  }
}

async function writeArchiveCommit(scratch: GitRepository, head: string | null, operation: WorkArchiveOperation, bodies: readonly WorkArchiveBody[]): Promise<string> {
  // The blob of each body, by content hash.
  const blobs = new Map<string, string>()
  if (head) {
    for (const line of (await scratch.git(['ls-tree', `${head}:bodies`])).trim().split('\n').filter(Boolean)) {
      const match = /^100644 blob ([a-f0-9]{40})\t([a-f0-9]{64})$/.exec(line)
      if (!match) throw new Error('The archive body tree is invalid.')
      blobs.set(match[2]!, match[1]!)
    }
  }
  for (const body of bodies) {
    if (documentContentHash(body.content) !== body.hash) throw new Error('An archive input body is corrupt.')
    const blob = await scratch.writeBlob({ content: body.content })
    const existing = blobs.get(body.hash)
    if (existing && existing !== blob) throw new Error('An immutable body changed.')
    blobs.set(body.hash, blob)
  }
  for (const hash of [operation.manifest.work.contentHash, ...operation.manifest.revisions.map(revision => revision.contentHash)]) {
    if (!blobs.has(hash)) throw new Error('The archive has a missing content reference.')
  }
  const extension = operation.manifest.work.type === 'doc' ? 'md' : operation.manifest.work.type === 'artifact' ? 'html' : 'json'
  return scratch.writeCommit({
    parent: head, message: `Solus work ${operation.manifest.operationId}`, date: operation.capturedAt,
    // The archive names each body, so the tree has no file that the manifest does not know.
    keepParentFiles: false,
    entries: [
      ...[...blobs].map(([hash, blob]) => ({ path: `bodies/${hash}`, blob })),
      { path: `content.${extension}`, blob: blobs.get(operation.manifest.work.contentHash)! },
      { path: 'manifest.json', content: JSON.stringify(operation.manifest) },
    ],
  })
}
