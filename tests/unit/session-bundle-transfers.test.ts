import { afterAll, expect, mock, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionRepositories, sessionRepositoryName } from '@solus/server/sync/sessions/session-repository'
import { SessionBundleTransfers } from '@solus/server/sync/sessions/session-bundle-transfers'

mock.module('@solus/server/cli-env', () => ({ hostCliEnv: (extra: NodeJS.ProcessEnv) => ({ ...process.env, ...extra }) }))
mock.module('@solus/server/vault/acting-scope', () => ({ withUserScope: (_key: null, run: () => Promise<string>) => run() }))

const root = mkdtempSync(join(tmpdir(), 'solus-bundle-transfer-test-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = root
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

// WHY: the full provider transcript can make a bundle larger than one RPC frame.
// Each answer must stay bounded, and a second host must fetch the exact bytes.
test('a session bundle crosses RPC in bounded chunks and advances another repository', async () => {
  const source = new SessionRepositories(join(root, 'source'))
  const target = new SessionRepositories(join(root, 'target'))
  const repository = sessionRepositoryName('local', 'bundle-session')
  const payload = join(root, 'payload.bin')
  writeFileSync(payload, randomBytes(2 * 1024 * 1024))
  const head = await source.named(repository).commit({ expectedHead: null, message: 'turn', entries: [{ path: 'threads/thread/main/0', file: payload }] })
  const transfers = new SessionBundleTransfers(source)
  try {
    const started = await transfers.start('bundle-session', repository, null, 'person-one')
    expect(started.state).toBe('ready')
    if (started.state !== 'ready') return
    expect(started.size).toBeGreaterThan(1024 * 1024)
    expect(transfers.sessionOf(started.transferId, 'person-two')).toBeNull()
    await expect(transfers.chunk(started.transferId, 0, 'person-two')).rejects.toThrow()
    const bundle = join(root, 'received.bundle')
    for (let offset = 0; offset < started.size;) {
      const chunk = await transfers.chunk(started.transferId, offset, 'person-one')
      const bytes = Buffer.from(chunk.data, 'base64')
      expect(bytes.length).toBeLessThanOrEqual(1024 * 1024)
      offset += bytes.length
      expect(chunk.done).toBe(offset === started.size)
      appendFileSync(bundle, bytes)
    }
    expect(await target.named(repository).fetchBundle(bundle)).toBe(head)
    expect(transfers.sessionOf(started.transferId, 'person-one')).toBeNull()
  } finally {
    await transfers.stop()
  }
})
