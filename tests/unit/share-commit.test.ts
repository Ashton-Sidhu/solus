import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Principal } from '@solus/server/server/principal'

const dataDir = mkdtempSync(join(tmpdir(), 'solus-notify-test-'))
process.env.SOLUS_DATA_DIR = dataDir
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let database: typeof import('@solus/server/db/database')
let sharing: typeof import('@solus/server/sharing/share-manager')
beforeAll(async () => {
  database = await import('@solus/server/db/database')
  sharing = await import('@solus/server/sharing/share-manager')
})
afterAll(async () => {
  await database.closeDatabase()
  ;(await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})
const principal: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Test' }

test('share notifications cannot escape an outer rollback', async () => {
  const shares = new sharing.ShareManager({ db: database.getDatabase() })
  const resource = { kind: 'work' as const, id: 'rollback-share' }
  await shares.claimOwner(resource, principal)
  const changes: string[] = []
  const stop = shares.onChanged(change => changes.push(change.resource.id))
  try {
    await expect(database.getDatabase().transaction(async () => {
      await shares.setLink({ resource, role: 'viewer' }, principal)
      expect(changes).toEqual([])
      throw new Error('abort')
    })).rejects.toThrow('abort')
    expect(changes).toEqual([])
    expect((await shares.list(resource, principal)).link).toBeNull()
    await shares.setLink({ resource, role: 'editor' }, principal)
    expect(changes).toEqual([resource.id])
  } finally { stop() }
})

