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

let outbox: typeof import('@solus/server/sync/outbox/outbox-store')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-outbox-changed-'))
  process.env.SOLUS_DATA_DIR = dataDir
  outbox = await import('@solus/server/sync/outbox/outbox-store')
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
  const unsubscribe = outbox.onOutboxChanged(() => changes.push(true))
  try {
    run()
  } finally {
    unsubscribe()
  }
  return changes
}

describe('outbox change announcements', () => {
  test('every outbox change is one a client courier lists, and the delivery queue to the Solus API announces nothing to couriers', async () => {
    const queue = await import('@solus/server/sync/delivery-queue')
    const changes = recordChanges(() => {
      queue.queueSessionFacts({ organizationId: 'org1', actorUserId: '' }, { sessionId: 's-1', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
      queue.appendDelivery({ organizationId: 'org1', actorUserId: '' }, 'transcript', [{ key: 's-1:0', payload: { sessionId: 's-1', position: 0, message: {} } }])
      const hostOp = outbox.recordOutboxOp({ domain: 'tasks', resourceId: 't-host', name: 'setStatus', payload: {} })
      outbox.ackOutboxOps([hostOp.id])
      const deadOp = outbox.recordOutboxOp({ domain: 'tasks', resourceId: 't-dead', name: 'setStatus', payload: {} })
      outbox.markOutboxOpsFailed([{ id: deadOp.id, error: 'refused' }])
      expect(outbox.listOutboxOps().map((op) => op.id)).toContain(deadOp.id)
    })

    expect(changes).toEqual([
      true, // host op recorded
      true, // host op acked
      true, // op recorded
      true, // dead-lettered op stays listed
    ])
  })
})
