import { afterAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionBundleDivergedError, SessionRepositories, sessionRepositoryName } from '@solus/server/sync/sessions/session-repository'
import { emptySessionManifest } from '@solus/server/sync/sessions/session-manifest'

mock.module('@solus/server/cli-env', () => ({ hostCliEnv: (extra: NodeJS.ProcessEnv) => ({ ...process.env, ...extra }) }))
mock.module('@solus/server/vault/acting-scope', () => ({ withUserScope: (_key: null, run: () => Promise<string>) => run() }))

const root = mkdtempSync(join(tmpdir(), 'solus-session-repository-sync-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = root
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})
const repository = sessionRepositoryName('local', 'portable')

function copies(name: string): SessionRepositories {
  return new SessionRepositories(join(root, name))
}

describe('session repository bundles', () => {
  // WHY: a bundle must never be written into the host's process directory.
  test('a relative output path is refused before Git writes a bundle', async () => {
    const source = copies('relative-path-source')
    await source.named(repository).commit({ expectedHead: null, message: 'turn', entries: [{ path: 'turn', content: 'saved' }] })
    await expect(source.named(repository).bundleSince(null, 'source')).rejects.toThrow('must be absolute')
    expect(existsSync('source')).toBe(false)
  })
  // WHY: a second host must get only the new turns and rebuild the exact
  // provider file. Its first fetch also has to create its local repository.
  test('an incremental bundle advances a second copy and joins thread ranges', async () => {
    const source = copies('source')
    const target = copies('target')
    const first = await source.named(repository).commit({ expectedHead: null, message: 'first', entries: [
      { path: 'threads/thread/main/0', content: 'first\n' },
      { path: 'manifest.json', content: JSON.stringify(emptySessionManifest('portable', 'local')) },
    ] })
    const firstBundle = join(root, 'first.bundle')
    expect(await source.named(repository).bundleSince(null, firstBundle)).toEqual({ kind: 'written', head: first })
    expect(await target.named(repository).head()).toBeNull()
    expect(await target.named(repository).fetchBundle(firstBundle)).toBe(first)
    const second = await source.named(repository).commit({ expectedHead: first, message: 'second', entries: [
      { path: 'threads/thread/main/1', content: 'second\n' },
    ] })
    const laterBundle = join(root, 'later.bundle')
    expect(await source.named(repository).bundleSince(first, laterBundle)).toEqual({ kind: 'written', head: second })
    const newHost = copies('missing-prerequisite')
    await expect(newHost.named(repository).fetchBundle(laterBundle)).rejects.toThrow()
    expect(await newHost.named(repository).head()).toBeNull()
    expect(await target.named(repository).fetchBundle(laterBundle)).toBe(second)
    expect(await target.named(repository).head()).toBe(second)
    const out = join(root, 'joined.txt')
    await target.named(repository).writeThreadFile(second, 'thread', { key: 'main', relativePath: 'thread.jsonl', length: 13, parts: [0, 1] }, out)
    expect(readFileSync(out, 'utf8')).toBe('first\nsecond\n')
    expect(await source.named(repository).bundleSince(second, laterBundle)).toEqual({ kind: 'current', head: second })
  })

  // WHY: two hosts can write from the same turn while offline. Fetch must not
  // replace one host's turns with the other host's branch.
  test('a divergent bundle is refused without moving the local copy', async () => {
    const source = copies('divergent-source')
    const target = copies('divergent-target')
    const first = await source.named(repository).commit({ expectedHead: null, message: 'first', entries: [{ path: 'one', content: 'one' }] })
    const baseBundle = join(root, 'base.bundle')
    await source.named(repository).bundleSince(null, baseBundle)
    await target.named(repository).fetchBundle(baseBundle)
    const local = await target.named(repository).commit({ expectedHead: first, message: 'local', entries: [{ path: 'local', content: 'local' }] })
    await source.named(repository).commit({ expectedHead: first, message: 'remote', entries: [{ path: 'remote', content: 'remote' }] })
    const remoteBundle = join(root, 'remote.bundle')
    await source.named(repository).bundleSince(first, remoteBundle)
    await expect(target.named(repository).fetchBundle(remoteBundle)).rejects.toBeInstanceOf(SessionBundleDivergedError)
    expect(await target.named(repository).head()).toBe(local)
    expect(await target.named(repository).readText(local, 'local')).toBe('local')
    expect(await source.named(repository).bundleSince(local, remoteBundle)).toEqual({ kind: 'diverged', head: await source.named(repository).head() })
  })

  // WHY: a host can read a repository written before the sync fields existed.
  test('a phase-1 manifest still parses', async () => {
    const source = copies('phase-one')
    const old = emptySessionManifest('portable', 'local')
    const head = await source.named(repository).commit({ expectedHead: null, message: 'old', entries: [{ path: 'manifest.json', content: JSON.stringify(old) }] })
    expect(await source.named(repository).readManifest(head)).toEqual(old)
  })
})
