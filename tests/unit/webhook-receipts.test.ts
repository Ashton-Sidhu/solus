import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { WebhookDeliverySummary, WebhookVerification } from '@solus/contracts/webhooks'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))
mock.module('@solus/server/project-config/projects-manifest', () => ({ listProjects: async () => [] }))

// WHY: plans/029-fresh-database-baseline.md §3.6, plan 027 step 5. The key
// claims and the delivery row commit together; a duplicate is a decision that
// keeps the IDs it consumed; events and the actions wait for the outermost
// commit. Socket-free: the receiver is called directly.

/** A fault the receiver cannot tell from a real one: the delivery log refuses the next insert. */
const actualStore = await import('@solus/server/data/webhooks/webhook-store')
// The namespace is a live binding that the mock replaces; the real insert is kept by value.
const realInsertDelivery = actualStore.insertDelivery
const faults = { failNextDeliveryInsert: false }
mock.module('@solus/server/data/webhooks/webhook-store', () => ({
  ...actualStore,
  insertDelivery: async (...args: Parameters<typeof realInsertDelivery>) => {
    if (faults.failNextDeliveryInsert) {
      faults.failNextDeliveryInsert = false
      throw new Error('delivery log unavailable')
    }
    return realInsertDelivery(...args)
  },
}))

let dataDir: string
let store: typeof import('@solus/server/data/webhooks/webhook-store')
let secrets: typeof import('@solus/server/data/webhooks/webhook-secrets')
let receiverModule: typeof import('@solus/server/execution/webhooks/receiver')
let proofModule: typeof import('@solus/server/execution/webhooks/delivery-proof')
let database: typeof import('@solus/server/db/database')
let receiptsSchema: typeof import('@solus/server/data/receipts/schema')
const events: WebhookDeliverySummary[] = []
let stopEvents: () => void = () => {}
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-webhook-receipts-'))
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/webhooks/webhook-store')
  secrets = await import('@solus/server/data/webhooks/webhook-secrets')
  receiverModule = await import('@solus/server/execution/webhooks/receiver')
  proofModule = await import('@solus/server/execution/webhooks/delivery-proof')
  database = await import('@solus/server/db/database')
  receiptsSchema = await import('@solus/server/data/receipts/schema')
  const { onWebhookDelivery } = await import('@solus/server/execution/webhooks/webhook-events')
  stopEvents = onWebhookDelivery((event) => events.push(event))
})

afterEach(async () => {
  events.length = 0
  faults.failNextDeliveryInsert = false
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  stopEvents()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const SECRET = Buffer.from('github-secret')
const TOKEN = 'url-token'
const HMAC: WebhookVerification = {
  scheme: 'hmac', algorithm: 'sha256', signedText: '{{body}}',
  signature: { source: { kind: 'header', name: 'x-hub-signature-256' }, format: { encoding: 'hex', prefix: 'sha256=' } },
}
const FORWARDER_SECRET = Buffer.from('forwarder-secret')

async function makeWebhook(overrides: Partial<import('@solus/server/data/webhooks/webhook-store').WebhookRecord> = {}) {
  const record: import('@solus/server/data/webhooks/webhook-store').WebhookRecord = {
    id: `wh-${Math.random().toString(36).slice(2)}`,
    organizationId: 'local',
    ownerKey: 'user:owner',
    name: 'GitHub',
    enabled: true,
    project: null,
    verification: HMAC,
    replayKey: '{{headers.x-github-delivery}}',
    actions: [{ id: 'a1', type: 'send_to_session', sessionId: 's1', enabled: true, filters: [], template: 'x' }],
    createdBy: { kind: 'system' },
    copiedUrlHash: null,
    lostCount: 0,
    lostAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
  await store.insertWebhook(record)
  secrets.writeWebhookSecrets(record.id, { token: TOKEN, secret: SECRET.toString('base64') })
  return record
}

function receiver() {
  const ran: string[] = []
  let clock = Date.now()
  const receiver = receiverModule.createWebhookReceiver({
    now: () => clock++,
    hostId: () => 'host-1',
    forwarderSecret: () => FORWARDER_SECRET,
    isPausedByAdmin: () => false,
    allowsUnverifiedWebhooks: () => false,
    runDelivery: async (delivery) => { ran.push(delivery.deliveryId) },
  })
  return { receiver, ran }
}

/** A signed request for `webhookId` with a proven forwarder delivery id and a GitHub delivery header (the replay key). */
function request(webhookId: string, deliveryId: string, replayKey: string) {
  const body = '{}'
  const receivedAt = String(Date.now() - 1000)
  const proof = proofModule.deliveryProof(FORWARDER_SECRET, 'host-1', webhookId, deliveryId, receivedAt)
  const headers: [string, string][] = [
    ['x-hub-signature-256', `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`],
    ['x-solus-hook-delivery-id', deliveryId], ['x-solus-hook-received-at', receivedAt], ['x-solus-hook-proof', proof],
    ['x-github-delivery', replayKey],
  ]
  return { method: 'POST', webhookId, token: TOKEN, headers, query: [], body: Buffer.from(body) }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

async function receiptsOf(webhookId: string): Promise<Array<{ namespace: string; key: string }>> {
  return database.getDatabase().all(sql`SELECT namespace, key FROM ${receiptsSchema.operationReceipts} WHERE scope = ${webhookId} ORDER BY namespace, key`)
}

describe('webhook receipts', () => {
  test('a pending-delivery insert that fails after the claims rolls them back, and the retry is accepted', async () => {
    const webhook = await makeWebhook()
    const { receiver: r, ran } = receiver()
    faults.failNextDeliveryInsert = true
    await expect(r.receive(request(webhook.id, 'fwd-1', 'g-1'))).rejects.toThrow('delivery log unavailable')
    await settle()
    expect(await receiptsOf(webhook.id)).toEqual([])
    expect(await store.listDeliveries(webhook.id)).toEqual([])
    expect(events).toEqual([])
    expect(ran).toEqual([])

    const retry = await r.receive(request(webhook.id, 'fwd-1', 'g-1'))
    expect(retry.outcome).toBe('accepted')
    expect(await receiptsOf(webhook.id)).toEqual([{ namespace: 'webhook-delivery', key: 'fwd-1' }, { namespace: 'webhook-replay', key: 'g-1' }])
    await settle()
    expect(ran).toEqual([retry.body.deliveryId!])
  })

  test('a new delivery ID with an old replay key is a duplicate that still consumes the ID', async () => {
    const webhook = await makeWebhook()
    const { receiver: r, ran } = receiver()
    expect((await r.receive(request(webhook.id, 'fwd-1', 'g-1'))).outcome).toBe('accepted')

    const replayed = await r.receive(request(webhook.id, 'fwd-2', 'g-1'))
    expect(replayed.outcome).toBe('duplicate')
    expect((await store.readDelivery(replayed.body.deliveryId!))?.reason).toBe('This replay key came before.')
    // The duplicate committed with the delivery ID it consumed: that ID stays spent whatever key it brings next.
    const sameId = await r.receive(request(webhook.id, 'fwd-2', 'g-2'))
    expect(sameId.outcome).toBe('duplicate')
    expect((await store.readDelivery(sameId.body.deliveryId!))?.reason).toBe('This delivery ID came before.')
    // A refused request consumed no replay key: g-2 is free for a new delivery.
    expect((await r.receive(request(webhook.id, 'fwd-3', 'g-2'))).outcome).toBe('accepted')

    expect((await receiptsOf(webhook.id)).map((row) => row.key).sort()).toEqual(['fwd-1', 'fwd-2', 'fwd-3', 'g-1', 'g-2'])
    await settle()
    expect(ran).toHaveLength(2)
    expect(events.map((event) => event.outcome)).toEqual(['pending', 'duplicate', 'duplicate', 'pending'])
  })

  test('a receive inside an outer transaction that rolls back leaves no receipt, delivery, event, or scheduled action', async () => {
    const webhook = await makeWebhook()
    const { receiver: r, ran } = receiver()
    await expect(database.getDatabase().transaction(async () => {
      const answer = await r.receive(request(webhook.id, 'fwd-1', 'g-1'))
      expect(answer.outcome).toBe('accepted')
      throw new Error('outer rollback')
    })).rejects.toThrow('outer rollback')
    await settle()
    await settle()
    expect(ran).toEqual([])
    expect(events).toEqual([])
    expect(await store.listDeliveries(webhook.id)).toEqual([])
    expect(await receiptsOf(webhook.id)).toEqual([])

    // Nothing was consumed: the same request is accepted, and its event and actions follow the commit.
    const again = await r.receive(request(webhook.id, 'fwd-1', 'g-1'))
    expect(again.outcome).toBe('accepted')
    expect(events.map((event) => event.id)).toEqual([again.body.deliveryId!])
    await settle()
    expect(ran).toEqual([again.body.deliveryId!])
  })

  test('deleting a webhook deletes its receipts by scope and leaves another webhook\'s', async () => {
    const kept = await makeWebhook()
    const deleted = await makeWebhook()
    const { receiver: r } = receiver()
    expect((await r.receive(request(kept.id, 'fwd-1', 'g-1'))).outcome).toBe('accepted')
    expect((await r.receive(request(deleted.id, 'fwd-1', 'g-1'))).outcome).toBe('accepted')
    expect(await store.deleteWebhook(deleted.id)).toBe(true)
    expect(await receiptsOf(deleted.id)).toEqual([])
    expect(await receiptsOf(kept.id)).toEqual([{ namespace: 'webhook-delivery', key: 'fwd-1' }, { namespace: 'webhook-replay', key: 'g-1' }])
  })
})
