import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withUserScope } from '../../vault/acting-scope'
import { GitRemote } from '../git-remote'
import { documentContentHash } from '../../docs/content-hash'
import { workArchiveManifestSchema, type WorkArchiveOperation, type WorkArchiveBody, type WorkArchiveTransport } from '../../data/works/git-work-storage'

export interface WorkRepositoryAccess {
  remote(repository: string): Promise<{ url: string; token?: string }>
  readFile(repository: string, commit: string, path: string): Promise<string>
  remove(repository: string): Promise<void>
}

/** Native Git object writes with no checkout, no token in config, and a checked remote head. */
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

  async push(repository: string, operation: WorkArchiveOperation, bodies: readonly WorkArchiveBody[]): Promise<string> {
    // These are service-owned archives, not a person's code checkout.
    return withUserScope(null, () => this.pushArchive(repository, operation, bodies))
  }

  private async pushArchive(repository: string, operation: WorkArchiveOperation, bodies: readonly WorkArchiveBody[]): Promise<string> {
    const remote = await this.access.remote(repository)
    const root = await mkdtemp(join(tmpdir(), 'solus-work-archive-'))
    const client = await GitRemote.open({ gitDir: root, remote: remote.url, token: remote.token,
      signal: this.signal, timeoutMs: 120_000, outputLimitBytes: 16 * 1024 * 1024, authorDate: operation.capturedAt })
    try {
      const git = (args: string[], input?: string) => client.git(args, input)
      await git(['init', '--bare', '--initial-branch=main'])
      await git(['config', 'remote.origin.promisor', 'true'])
      await git(['config', 'remote.origin.partialclonefilter', 'blob:none'])
      const head = await client.remoteHead()
      if (head) await git(['fetch', '--filter=blob:none', remote.url, 'refs/heads/main'])
      if (head) {
        const current = workArchiveManifestSchema.parse(JSON.parse(await git(['show', `${head}:manifest.json`])))
        if (current.operationId === operation.manifest.operationId) {
          if (JSON.stringify(current) !== JSON.stringify(operation.manifest)) throw new Error('The remote operation differs from the pending write.')
          return head
        }
        if (current.work.id !== operation.manifest.work.id || current.work.organizationId !== operation.manifest.work.organizationId) throw new Error('The archive belongs to another work.')
      }
      if (head !== operation.expectedCommit) throw new Error('The remote work changed before this push.')
      const commit = await buildArchiveCommit(git, head, operation, bodies)
      await git(['update-ref', 'refs/heads/main', commit])
      const pushed = await client.checkedPush(commit, head)
      if (pushed.status === 'refused') throw new Error('The remote work changed before this push.')
      if (pushed.status === 'failed') throw new Error('The archive push was not confirmed.')
      return commit
    } finally { await client.close(); await rm(root, { recursive: true, force: true }) }
  }
}

async function buildArchiveCommit(git: (args: string[], input?: string) => Promise<string>, head: string | null, operation: WorkArchiveOperation, bodies: readonly WorkArchiveBody[]): Promise<string> {
  const entries = new Map<string, string>()
  if (head) {
    for (const line of (await git(['ls-tree', `${head}:bodies`])).trim().split('\n').filter(Boolean)) {
      const match = /^100644 blob ([a-f0-9]{40})\t([a-f0-9]{64})$/.exec(line)
      if (!match) throw new Error('The archive body tree is invalid.')
      entries.set(match[2]!, match[1]!)
    }
  }
  for (const body of bodies) {
    if (documentContentHash(body.content) !== body.hash) throw new Error('An archive input body is corrupt.')
    const blob = (await git(['hash-object', '-w', '--stdin'], body.content)).trim()
    const existing = entries.get(body.hash)
    if (existing && existing !== blob) throw new Error('An immutable body changed.')
    entries.set(body.hash, blob)
  }
  for (const hash of [operation.manifest.work.contentHash, ...operation.manifest.revisions.map(revision => revision.contentHash)]) {
    if (!entries.has(hash)) throw new Error('The archive has a missing content reference.')
  }
  const tree = (await git(['mktree', '--missing'], [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([hash, blob]) => `100644 blob ${blob}\t${hash}\n`).join(''))).trim()
  const manifest = (await git(['hash-object', '-w', '--stdin'], JSON.stringify(operation.manifest))).trim()
  const extension = operation.manifest.work.type === 'doc' ? 'md' : operation.manifest.work.type === 'artifact' ? 'html' : 'json'
  const body = entries.get(operation.manifest.work.contentHash)!
  const rootTree = (await git(['mktree', '--missing'], `040000 tree ${tree}\tbodies\n100644 blob ${body}\tcontent.${extension}\n100644 blob ${manifest}\tmanifest.json\n`)).trim()
  return (await git(['commit-tree', rootTree, ...(head ? ['-p', head] : []), '-m', `Solus work ${operation.manifest.operationId}`])).trim()
}
