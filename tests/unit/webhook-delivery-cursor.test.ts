import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/**
 * plans/029 §8 (a carry-over of the first review): the deliveries list pages
 * on its own order, `(arrived_at, id)`. A cursor on the time alone skipped
 * every delivery that arrived in the same millisecond as the last one shown,
 * and a burst from a forwarder arrives like that.
 */

let dataDir: string
let store: typeof import('@solus/server/data/webhooks/webhook-store')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-delivery-cursor-'))
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/webhooks/webhook-store')
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

test('a page continues after the last delivery shown, through deliveries that arrived in the same millisecond', async () => {
  await store.insertWebhook({
    id: 'wh-1', organizationId: 'local', ownerKey: 'user:owner', name: 'Repo', enabled: true, project: null,
    verification: { scheme: 'none', reason: 'Test sender accepts only a URL.' }, replayKey: null, actions: [],
    createdBy: { kind: 'system' }, copiedUrlHash: null, lostCount: 0, lostAt: null, createdAt: 1, updatedAt: 1,
  })
  // Five deliveries: three in one millisecond, two earlier.
  const arrivals: Array<[string, number]> = [['d-a', 1_000], ['d-b', 1_000], ['d-c', 1_000], ['d-d', 900], ['d-e', 800]]
  for (const [id, arrivedAt] of arrivals) {
    await store.insertDelivery({ id, webhookId: 'wh-1', receivedAt: arrivedAt, arrivedAt, source: 'direct', outcome: 'ran', reason: null, replayOf: null,
      request: { method: 'POST', headers: [], query: [], body: '', bodyIsBase64: false }, verificationFailure: null, actions: [] })
  }
  const first = await store.listDeliveries('wh-1', { limit: 2 })
  expect(first.map((delivery) => delivery.id)).toEqual(['d-c', 'd-b'])
  const last = first.at(-1)!
  const second = await store.listDeliveries('wh-1', { limit: 2, before: last.arrivedAt, beforeId: last.id })
  expect(second.map((delivery) => delivery.id)).toEqual(['d-a', 'd-d'])
  const third = await store.listDeliveries('wh-1', { limit: 2, before: second.at(-1)!.arrivedAt, beforeId: second.at(-1)!.id })
  expect(third.map((delivery) => delivery.id)).toEqual(['d-e'])
  // A client with the time alone still pages, by time.
  expect((await store.listDeliveries('wh-1', { limit: 5, before: 1_000 })).map((delivery) => delivery.id)).toEqual(['d-d', 'd-e'])
})
