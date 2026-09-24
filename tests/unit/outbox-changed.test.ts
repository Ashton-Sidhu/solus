import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// WHY: every connected client drains the host outbox with `outboxList` when it
// hears `outbox.changed`. A linked runner queues a session report on each
// session-record write — several per turn — and those reports never reach a
// client courier. Announcing them to clients sent a burst of empty drains per turn.

let outbox: typeof import('@solus/server/outbox/outbox-store')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-outbox-changed-'))
  process.env.SOLUS_DATA_DIR = dataDir
  outbox = await import('@solus/server/outbox/outbox-store')
  dbModule = await import('@solus/server/db')
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

function recordChanges(run: () => void): boolean[] {
  const changes: boolean[] = []
  const unsubscribe = outbox.onOutboxChanged(({ courierListChanged }) => changes.push(courierListChanged))
  try {
    run()
  } finally {
    unsubscribe()
  }
  return changes
}

describe('outbox change announcements', () => {
  test('only a change to what a client courier lists is announced to couriers', () => {
    const changes = recordChanges(() => {
      outbox.queueSessionReport({ sessionId: 's-1', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
      const cloudOp = outbox.recordOutboxOp({ domain: 'tasks', resourceId: 't-cloud', name: 'setStatus', payload: {}, destination: 'cloud' })
      outbox.ackCloudOutboxOpsThrough(Number.MAX_SAFE_INTEGER)
      expect(outbox.listOutboxOps().map((op) => op.id)).not.toContain(cloudOp.id)

      const hostOp = outbox.recordOutboxOp({ domain: 'tasks', resourceId: 't-host', name: 'setStatus', payload: {} })
      outbox.ackOutboxOps([hostOp.id])
      const deadCloudOp = outbox.recordOutboxOp({ domain: 'tasks', resourceId: 't-dead', name: 'setStatus', payload: {}, destination: 'cloud' })
      outbox.markOutboxOpsFailed([{ id: deadCloudOp.id, error: 'refused' }])
      expect(outbox.listOutboxOps().map((op) => op.id)).toContain(deadCloudOp.id)
    })

    expect(changes).toEqual([
      false, // session report
      false, // cloud op recorded
      false, // cloud op acked by the workspace service
      true, // host op recorded
      true, // host op acked
      false, // cloud op recorded
      true, // dead-lettered cloud op becomes listed
    ])
  })
})
