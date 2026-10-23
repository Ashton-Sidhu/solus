import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'
import type { Principal } from '@solus/server/admission/principal'
import { seedResource } from './helpers/resource-rows'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { ShareManager } = await import('@solus/server/sharing/share-manager')
const { applyMirrorItem } = await import('@solus/server/sync/mirror/mirror-sinks')
const { getDatabase } = await import('@solus/server/db/database')

// docs/plans/host-sharing.md §2: the host that runs a session owns its share rows; the
// Solus API holds a copy, sent when it changes, so it can admit a guest and read
// the session to them while the host is unreachable.
describe('mirrored share rows', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string
  const owner: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Desktop' }
  const session = { kind: 'session', id: 's1' } as const

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-share-mirror-'))
    process.env.SOLUS_DATA_DIR = dataDir
  })
  afterEach(async () => {
    await resetTestDatabase()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('the rows the host sends admit the same secret on the copy, and a regenerated link ends the old one', async () => {
    // One database stands in for both: the host writes the link, the copy receives the rows.
    const host = new ShareManager({ db: getDatabase() })
    const { hostUserKey } = await import('@solus/server/host/host-user')
    await seedResource(getDatabase(), 'session', session.id, hostUserKey())
    const link = (await host.setLink({ resource: session, role: 'editor' }, owner))!
    const rows = await host.mirroredRows(session)
    // WHY: the secret itself never leaves the host; the copy admits by hash alone.
    expect(rows).toEqual([expect.objectContaining({ subjectKind: 'everyone', role: 'editor', linkSecretHash: expect.any(String) })])
    expect(JSON.stringify(rows)).not.toContain(link.secret)

    const copy = new ShareManager({ db: getDatabase() })
    const changes: boolean[] = []
    copy.onChanged((change) => { changes.push(change.guestsRevoked) })
    await host.forget(session)
    await applyMirrorItem({ organizationId: 'org1', hostId: 'h1' }, { kind: 'shares', payload: { resource: session, rows } }, copy)
    const resolved = await copy.resolveLinkSecret(link.secret)
    expect(resolved).toMatchObject({ resource: session, role: 'editor', organizationId: 'org1' })
    expect(changes).toEqual([false])

    // The host regenerated the link: the next rows carry another hash, and the copy drops the old guests.
    const rotated = rows.map((row) => (row.subjectKind === 'everyone' ? { ...row, linkSecretHash: 'other' } : row))
    await applyMirrorItem({ organizationId: 'org1', hostId: 'h1' }, { kind: 'shares', payload: { resource: session, rows: rotated } }, copy)
    expect(await copy.resolveLinkSecret(link.secret)).toBeNull()
    expect(changes).toEqual([false, true])
  })

  test('a payload the schema refuses is permanent, and a service without share rows refuses every one', async () => {
    const copy = new ShareManager({ db: getDatabase() })
    await expect(applyMirrorItem({ organizationId: 'org1', hostId: 'h1' }, { kind: 'shares', payload: { rows: 'no' } }, copy)).rejects.toThrow('Malformed shares mirror payload')
    await expect(applyMirrorItem({ organizationId: 'org1', hostId: 'h1' }, { kind: 'shares', payload: { resource: session, rows: [] } })).rejects.toThrow('keeps no share rows')
  })
})
