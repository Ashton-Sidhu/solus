import { afterAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloudSessionRepositoryName } from '@solus/server/data/sessions/session-repositories'
import { storageRepositoryName } from '@solus/server/data/storage-repository-name'
import type { WorkArchiveOperation } from '@solus/server/data/works/git-work-storage'
import { documentContentHash } from '@solus/server/docs/content-hash'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { GitRepository } from '@solus/server/sync/git-storage/git-repository'
import { LocalGitRepositoryProvider } from '@solus/server/sync/git-storage/local-git-repository-provider'
import type { RepositoryProvider } from '@solus/server/sync/git-storage/repository-provider'
import { sessionRepositoryName } from '@solus/server/sync/sessions/session-repository'
import { GitWorkTransport } from '@solus/server/sync/works/git-work-transport'

actAsHostForTests()
const root = mkdtempSync(join(tmpdir(), 'solus-git-storage-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const IDENTITY = { GIT_AUTHOR_NAME: 'Solus', GIT_AUTHOR_EMAIL: 'storage@solus.invalid', GIT_COMMITTER_NAME: 'Solus', GIT_COMMITTER_EMAIL: 'storage@solus.invalid' }

function git(gitDir: string, args: string[], input?: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', ['--git-dir', gitDir, ...args], { input, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } }).trim()
}

// WHY: a record keeps the name of its repository. A different rule gives
// another name, and the work or the session loses its history on disk and in
// Cloudflare. These names come from the rule before the shared layer.
test('each feature keeps the repository names it had', () => {
  expect(storageRepositoryName('work', 'org-a', 'work-1')).toBe('work-7837c1a316051e9bfb0c265edd04eed43ef3d7f0c54d9afc')
  expect(sessionRepositoryName('local', 'session-1')).toBe('session-f7b1d620709f0a293f93637bf02eed3f744d72a40f98be3c')
  expect(cloudSessionRepositoryName('person:alice', 'session-1')).toBe('session-503c8e427fd05951d8527bdc3405e2c2b384bfbeb6513f04')
})

function operation(operationId: string, generation: number, contentHash: string, revisionHashes: string[], expectedCommit: string | null): WorkArchiveOperation {
  const capturedAt = `2026-11-20T10:00:0${generation}.000Z`
  return {
    manifest: {
      schemaVersion: 1, operationId, generation,
      work: {
        id: 'work-1', organizationId: 'org-a', title: 'Notes', preview: '', type: 'doc', createdAt: capturedAt, updatedAt: capturedAt,
        agentProvider: 'codex', cwd: '/tmp', contentVersion: generation, contentHash, contentAuthor: null,
      },
      previousRevisionId: null,
      revisions: revisionHashes.map((hash, index) => ({
        workId: 'work-1', revisionId: index + 1, reason: 'agent' as const, sourceContentVersion: null, author: null, contentHash: hash, capturedAt,
      })),
    },
    expectedCommit, hashes: [], capturedAt,
  }
}

// WHY: the storage format of a work must not change. The archive that the
// shared commit builder writes is the same Git commit as the one made from the
// documented layout (`bodies/<hash>`, `content.md`, `manifest.json`), so each
// archive from before stays readable and a retry gives the same commit.
test('a work archive commit is the documented tree, with each older body kept', async () => {
  const provider: RepositoryProvider = new LocalGitRepositoryProvider(join(root, 'works'), 'work')
  const transport = new GitWorkTransport(provider)
  const repository = storageRepositoryName('work', 'org-a', 'work-1')
  const gitDir = join(root, 'works', `${repository}.git`)
  const first = 'First body\n'
  const second = 'Second body\n\n'
  const hashes = [documentContentHash(first), documentContentHash(second)] as const

  // As with Artifacts, the fetch gets no blob, so the second push has the first body only as a name in the tree.
  await provider.remote(repository, 'write')
  git(gitDir, ['config', 'uploadpack.allowFilter', 'true'])
  git(gitDir, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])

  const firstOperation = operation('op-1', 1, hashes[0], [], null)
  const firstCommit = await transport.push(repository, firstOperation, [{ hash: hashes[0], content: first }])
  const secondOperation = operation('op-2', 2, hashes[1], [hashes[0]], firstCommit)
  const secondCommit = await transport.push(repository, secondOperation, [{ hash: hashes[1], content: second }])

  const expected = (item: WorkArchiveOperation, bodies: Array<[string, string]>, parent: string | null) => {
    const blobs = bodies.map(([hash, content]) => [hash, git(gitDir, ['hash-object', '-w', '--stdin'], content)] as const).sort(([a], [b]) => a.localeCompare(b))
    const bodyTree = git(gitDir, ['mktree'], blobs.map(([hash, blob]) => `100644 blob ${blob}\t${hash}\n`).join(''))
    const manifest = git(gitDir, ['hash-object', '-w', '--stdin'], JSON.stringify(item.manifest))
    const current = blobs.find(([hash]) => hash === item.manifest.work.contentHash)![1]
    const tree = git(gitDir, ['mktree'], `040000 tree ${bodyTree}\tbodies\n100644 blob ${current}\tcontent.md\n100644 blob ${manifest}\tmanifest.json\n`)
    return git(gitDir, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Solus work ${item.manifest.operationId}`], undefined,
      { ...IDENTITY, GIT_AUTHOR_DATE: item.capturedAt, GIT_COMMITTER_DATE: item.capturedAt })
  }
  expect(firstCommit).toBe(expected(firstOperation, [[hashes[0], first]], null))
  expect(secondCommit).toBe(expected(secondOperation, [[hashes[0], first], [hashes[1], second]], firstCommit))
  expect(git(gitDir, ['rev-parse', 'refs/heads/main'])).toBe(secondCommit)
  // The body keeps its last newline: the content hash is of the exact text.
  expect(await transport.read(repository, secondCommit, hashes[1])).toBe(second)
  expect(await transport.read(repository, secondCommit, hashes[0])).toBe(first)
})

// WHY: a work with a long history must not download each older body to save
// one change. That is the reason for the fetch with no blobs, so a commit that
// names an older body must not need its content.
test('a commit names a blob that only the remote has', async () => {
  const remotePath = join(root, 'partial-remote.git')
  const remote = new GitRepository(remotePath)
  await remote.init()
  git(remotePath, ['config', 'uploadpack.allowFilter', 'true'])
  const older = await remote.writeBlob({ content: 'older body' })
  const head = await remote.writeCommit({ parent: null, message: 'first', keepParentFiles: false, entries: [{ path: 'bodies/older', blob: older }] })
  await remote.setHead(head, null)

  const scratch = new GitRepository(join(root, 'partial-scratch.git'), { env: { GIT_NO_LAZY_FETCH: '1' } })
  await scratch.init()
  await scratch.fetchMain(`file://${remotePath}`, 'blob:none')
  await expect(scratch.readText(head, 'bodies/older')).rejects.toThrow()
  const next = await scratch.writeCommit({
    parent: head, message: 'second', keepParentFiles: false,
    entries: [{ path: 'bodies/older', blob: older }, { path: 'bodies/newer', content: 'newer body' }],
  })
  expect(git(scratch.path, ['ls-tree', '-r', '--name-only', next])).toBe('bodies/newer\nbodies/older')
  expect(git(scratch.path, ['rev-parse', `${next}:bodies/older`])).toBe(older)
})

// WHY: a provider of one feature must not open the repository of the other feature.
test('a local provider reads a file at a commit and opens only the repositories of its feature', async () => {
  const provider: RepositoryProvider = new LocalGitRepositoryProvider(join(root, 'sessions'), 'session')
  const repository = cloudSessionRepositoryName('person:alice', 'session-1')
  const { url } = await provider.remote(repository, 'write')
  const copy = new GitRepository(new URL(url).pathname)
  const head = await copy.writeCommit({ parent: null, message: 'turn', keepParentFiles: true, entries: [{ path: 'rows/0.jsonl', content: '12345' }] })
  await copy.setHead(head, null)

  expect(provider.storageScope).toBe(`file://${join(root, 'sessions')}`)
  expect(await provider.readFile(repository, head, 'rows/0.jsonl')).toBe('12345')
  await expect(provider.remote(storageRepositoryName('work', 'org-a', 'work-1'), 'write')).rejects.toThrow('Invalid session repository name')
  await expect(provider.remove('../outside')).rejects.toThrow('Invalid session repository name')
})

// WHY: a storage repository is a folder that only Solus writes, but a hook in
// it is code. No Git process of the storage layer runs one, for a work and
// for a session.
test('a hook in a storage repository does not run', async () => {
  const copy = new GitRepository(join(root, 'hooks.git'))
  await copy.init()
  const hook = join(copy.path, 'hooks', 'reference-transaction')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  chmodSync(hook, 0o755)
  const commit = await copy.writeCommit({ parent: null, message: 'first', keepParentFiles: true, entries: [{ path: 'file', content: 'text' }] })
  expect(() => git(copy.path, ['update-ref', 'refs/heads/other', commit])).toThrow()
  await copy.setHead(commit, null)
  expect(await copy.head()).toBe(commit)
})
