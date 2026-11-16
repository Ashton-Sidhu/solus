import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WEBHOOK_TEST_HEADER, type WebhookVerification } from '@solus/contracts/webhooks'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))
mock.module('@solus/server/project-config/projects-manifest', () => ({ listProjects: async () => [] }))

// docs/plans/apps.md §9.2: Send test signs a request with the webhook's stored
// secret, as the sender does, and gives it to the host's own receiver. The
// test must pass the same verification as a real delivery, or it proves
// nothing; and it must go through the receiver, so the log keeps it and the
// pause and policy checks hold for it too.

let dataDir: string
let store: typeof import('@solus/server/data/webhooks/webhook-store')
let secrets: typeof import('@solus/server/data/webhooks/webhook-secrets')
let receiverModule: typeof import('@solus/server/execution/webhooks/receiver')
let testDelivery: typeof import('@solus/server/execution/webhooks/test-delivery')
let verification: typeof import('@solus/server/execution/webhooks/verification')
let requestData: typeof import('@solus/server/execution/webhooks/request-data')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-webhook-send-test-'))
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/webhooks/webhook-store')
  secrets = await import('@solus/server/data/webhooks/webhook-secrets')
  receiverModule = await import('@solus/server/execution/webhooks/receiver')
  testDelivery = await import('@solus/server/execution/webhooks/test-delivery')
  verification = await import('@solus/server/execution/webhooks/verification')
  requestData = await import('@solus/server/execution/webhooks/request-data')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const SECRET = Buffer.from('a-shared-secret')
const NOW = 1_800_000_000_000

const SCHEMES: { name: string; verification: WebhookVerification }[] = [
  {
    name: 'an HMAC of the body in one header (GitHub)',
    verification: { scheme: 'hmac', algorithm: 'sha256', signedText: '{{body}}', signature: { source: { kind: 'header', name: 'x-hub-signature-256' }, format: { encoding: 'hex', prefix: 'sha256=' } } },
  },
  {
    name: 'an HMAC over a timestamp in the same header as the signature (Stripe)',
    verification: {
      scheme: 'hmac', algorithm: 'sha256', signedText: '{{headers.stripe-signature|t}}.{{body}}',
      signature: { source: { kind: 'header_part', name: 'Stripe-Signature', key: 'v1', separator: ',' }, format: { encoding: 'hex' } },
      timestamp: { source: { kind: 'header_part', name: 'Stripe-Signature', key: 't', separator: ',' }, toleranceSeconds: 300 },
    },
  },
  { name: 'Standard Webhooks', verification: { scheme: 'standard_webhooks' } },
  { name: 'a bearer token', verification: { scheme: 'token', source: { kind: 'bearer' } } },
  { name: 'no verification', verification: { scheme: 'none', reason: 'The sender only takes a URL.' } },
]

describe('the test request of a webhook', () => {
  for (const { name, verification: settings } of SCHEMES) {
    test(`passes the webhook's own verification: ${name}`, async () => {
      const request = testDelivery.testRequest({ name: 'Release', verification: settings }, SECRET, NOW)
      const data = requestData.requestData('POST', request.headers, [], request.body)
      expect(await verification.verifyRequest(settings, data, { secret: SECRET, now: NOW })).toEqual({ ok: true })
      expect(data.headers.get(WEBHOOK_TEST_HEADER)).toBe('1')
    })
  }

  test('a request signed with another secret does not pass: the signature depends on the secret', async () => {
    const settings = SCHEMES[0].verification
    const request = testDelivery.testRequest({ name: 'Release', verification: settings }, Buffer.from('another-secret'), NOW)
    const data = requestData.requestData('POST', request.headers, [], request.body)
    expect(await verification.verifyRequest(settings, data, { secret: SECRET, now: NOW })).toMatchObject({ ok: false, failure: { step: 'signature_mismatch' } })
  })

  test('a scheme whose private key the sender holds cannot be signed on the host', () => {
    const publicKey: WebhookVerification = { scheme: 'public_key', algorithm: 'ed25519', publicKey: 'AAAA', signedText: '{{body}}', signature: { source: { kind: 'header', name: 'x-signature' }, format: { encoding: 'base64' } } }
    expect(() => testDelivery.testRequest({ name: 'Release', verification: publicKey }, null, NOW)).toThrow('The sender holds the private key')
    expect(() => testDelivery.testRequest({ name: 'Release', verification: SCHEMES[0].verification }, null, NOW)).toThrow('no signing secret')
  })
})

describe('Send test', () => {
  async function makeWebhook(enabled = true) {
    const record: import('@solus/server/data/webhooks/webhook-store').WebhookRecord = {
      id: `wh-${Math.random().toString(36).slice(2)}`,
      organizationId: 'local',
      ownerKey: 'user:owner',
      name: 'Release',
      enabled,
      project: null,
      verification: SCHEMES[0].verification,
      replayKey: null,
      actions: [{ id: 'app', type: 'call_app', enabled: true, filters: [], template: '', appId: 'app-1', operation: 'recordRelease' }],
      createdBy: { kind: 'system' },
      copiedUrlHash: null,
      lostCount: 0,
      lostAt: null,
      createdAt: 1,
      updatedAt: 1,
    }
    await store.insertWebhook(record)
    secrets.writeWebhookSecrets(record.id, { token: 'url-token', secret: SECRET.toString('base64') })
    return record
  }

  function receiver() {
    const ran: string[] = []
    const receiver = receiverModule.createWebhookReceiver({
      hostId: () => null,
      forwarderSecret: () => null,
      isPausedByAdmin: () => false,
      organizationRefusal: () => null,
      runDelivery: async (delivery) => { ran.push(delivery.deliveryId) },
    })
    return { receiver, ran }
  }

  test('the receiver takes the signed test, the log keeps it as a delivery, and its actions run', async () => {
    const webhook = await makeWebhook()
    const { receiver: r, ran } = receiver()
    const summary = await testDelivery.sendTestDelivery(r, webhook)
    expect(summary).toMatchObject({ webhookId: webhook.id, outcome: 'pending', source: 'direct', replayOf: null })
    await new Promise((resolve) => setImmediate(resolve))
    expect(ran).toEqual([summary.id])

    const delivery = await store.readDelivery(summary.id)
    expect(delivery?.verificationFailure).toBeNull()
    expect(delivery?.request.headers).toContainEqual([WEBHOOK_TEST_HEADER, '1'])
    // The log never keeps the signature: a credential header is redacted.
    expect(delivery?.request.headers).toContainEqual(['x-hub-signature-256', '[redacted]'])
  })

  test('a paused webhook refuses the test as it refuses a real delivery, and nothing runs', async () => {
    const webhook = await makeWebhook(false)
    const { receiver: r, ran } = receiver()
    await expect(testDelivery.sendTestDelivery(r, webhook)).rejects.toThrow('This webhook is paused.')
    await new Promise((resolve) => setImmediate(resolve))
    expect(ran).toEqual([])
    expect((await store.listDeliveries(webhook.id, {})).map((delivery) => delivery.outcome)).toEqual(['paused'])
  })
})
