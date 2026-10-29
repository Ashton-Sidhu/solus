import { hostCliEnv } from '../../cli-env'
import { withUserScope } from '../../vault/acting-scope'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    const url = archiveRemoteUrl(remote.url)
    const root = await mkdtemp(join(tmpdir(), 'solus-work-archive-'))
    const deadline = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
    try {
      const askpass = join(root, 'askpass')
      await writeFile(askpass, `#!/bin/sh
case "$1" in
  *"https://$SOLUS_ARCHIVE_HOST'"*|*"https://$SOLUS_ARCHIVE_HOST/"*|*"https://x@$SOLUS_ARCHIVE_HOST'"*|*"https://x@$SOLUS_ARCHIVE_HOST/"*) ;;
  *) exit 1 ;;
esac
case "$1" in
  Username*) printf 'x\n' ;;
  Password*) printf '%s\n' "$SOLUS_ARCHIVE_TOKEN" ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 })
      const env = hostCliEnv({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass,
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        SOLUS_ARCHIVE_HOST: url.host, SOLUS_ARCHIVE_TOKEN: remote.token?.split('?expires=')[0],
        GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
        GIT_CONFIG_KEY_2: 'protocol.file.allow', GIT_CONFIG_VALUE_2: 'always',
        GIT_AUTHOR_NAME: 'Solus', GIT_AUTHOR_EMAIL: 'storage@solus.invalid',
        GIT_COMMITTER_NAME: 'Solus', GIT_COMMITTER_EMAIL: 'storage@solus.invalid',
        GIT_AUTHOR_DATE: operation.capturedAt, GIT_COMMITTER_DATE: operation.capturedAt,
      })
      for (const key of Object.keys(env)) if (key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE') delete env[key]
      const git = async (args: string[], input?: string): Promise<string> => {
        const child = spawn('git', args, { cwd: root, env, stdio: 'pipe', signal: deadline })
        const parts: Buffer[] = []
        let bytes = 0
        child.stdout.on('data', (part: Buffer) => { bytes += part.length; if (bytes > 16 * 1024 * 1024) child.kill(); else parts.push(part) })
        child.stderr.resume() // Never put credential-bearing Git diagnostics in logs or exceptions.
        child.stdin.on('error', () => {})
        child.stdin.end(input)
        const code = await new Promise<number>((resolve, reject) => {
          child.once('error', () => reject(new Error('The archive Git process could not run.')))
          child.once('close', status => resolve(status ?? 1))
        })
        if (code !== 0) throw new Error(`The archive Git ${args[0]} operation failed (${code}).`)
        return Buffer.concat(parts).toString('utf8')
      }
      await git(['init', '--bare', '--initial-branch=main'])
      await git(['remote', 'add', 'origin', remote.url])
      await git(['config', 'remote.origin.promisor', 'true'])
      await git(['config', 'remote.origin.partialclonefilter', 'blob:none'])
      const refs = (await git(['ls-remote', 'origin', 'refs/heads/main'])).trim()
      const head = refs ? refs.split(/\s+/)[0]! : null
      if (head) await git(['fetch', '--filter=blob:none', 'origin', 'refs/heads/main'])
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
      await git(['push', `--force-with-lease=refs/heads/main:${head ?? ''}`, 'origin', 'refs/heads/main:refs/heads/main'])
      const accepted = (await git(['ls-remote', 'origin', 'refs/heads/main'])).trim().split(/\s+/)[0]
      if (accepted !== commit) throw new Error('The archive push was not confirmed.')
      return commit
    } finally { await rm(root, { recursive: true, force: true }) }
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

function archiveRemoteUrl(remote: string): URL {
  const url = new URL(remote)
  if (url.username || url.password || url.search || url.hash || !['https:', 'file:'].includes(url.protocol)) throw new Error('The archive remote must not contain credentials.')
  return url
}
