import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server as HttpServer } from 'node:http'
import type { WebhookVerification } from '@solus/contracts/webhooks'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))
mock.module('@solus/server/project-config/projects-manifest', () => ({ listProjects: async () => [] }))

// docs/plans/webhooks.md §3.4: the receiver's checks run in a fixed order. The
// order is the security property: a flood is limited before any signature
// check, and a sender without the secret cannot tell a paused webhook from a
// wrong signature. Each answer names its outcome for the cloud forwarder.

let dataDir: string
let store: typeof import('@solus/server/data/webhooks/webhook-store')
let secrets: typeof import('@solus/server/data/webhooks/webhook-secrets')
let receiverModule: typeof import('@solus/server/execution/webhooks/receiver')
let proofModule: typeof import('@solus/server/execution/webhooks/delivery-proof')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-webhook-receiver-'))
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/webhooks/webhook-store')
  secrets = await import('@solus/server/data/webhooks/webhook-secrets')
  receiverModule = await import('@solus/server/execution/webhooks/receiver')
  proofModule = await import('@solus/server/execution/webhooks/delivery-proof')
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
    replayKey: null,
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

function signed(body: string, extra: [string, string][] = []): [string, string][] {
  return [['x-hub-signature-256', `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`], ...extra]
}

function receiver(overrides: Partial<import('@solus/server/execution/webhooks/receiver').WebhookReceiverDeps> = {}) {
  const ran: string[] = []
  let clock = Date.now()
  const receiver = receiverModule.createWebhookReceiver({
    now: () => clock++,
    hostId: () => 'host-1',
    forwarderSecret: () => FORWARDER_SECRET,
    isPausedByAdmin: () => false,
    // The host's rule: an unverified organization webhook is refused unless its policy allows it; a Local one is not.
    organizationRefusal: (organizationId: string, work: { unverified: boolean }) => work.unverified && organizationId !== 'local' ? 'A policy does not allow unverified webhooks here.' : null,
    runDelivery: async (delivery) => { ran.push(delivery.deliveryId) },
    ...overrides,
  })
  return { receiver, ran }
}

const post = (webhookId: string, body: string, headers: [string, string][], token = TOKEN) =>
  ({ method: 'POST', webhookId, token, headers, query: [], body: Buffer.from(body) })

describe('webhook receiver check order', () => {
  test('a signed request is accepted, logged as pending, and its actions run after the answer', async () => {
    const webhook = await makeWebhook()
    const { receiver: r, ran } = receiver()
    const answer = await r.receive(post(webhook.id, '{"a":1}', signed('{"a":1}')))
    expect(answer.status).toBe(202)
    expect(answer.outcome).toBe('accepted')
    expect(ran).toEqual([])
    await new Promise((resolve) => setImmediate(resolve))
    expect(ran).toEqual([answer.body.deliveryId!])
    const delivery = await store.readDelivery(answer.body.deliveryId!)
    expect(delivery?.outcome).toBe('pending')
    expect(delivery?.source).toBe('direct')
    expect(delivery?.request.headers).toContainEqual(['x-hub-signature-256', '[redacted]'])
  })

  test('an unknown webhook and a wrong token get the same 404, and nothing is logged', async () => {
    const webhook = await makeWebhook()
    const { receiver: r } = receiver()
    const wrongToken = await r.receive(post(webhook.id, '{}', signed('{}'), 'nope'))
    const unknown = await r.receive(post('wh-missing', '{}', signed('{}')))
    expect(wrongToken).toEqual(unknown)
    expect(wrongToken.status).toBe(404)
    expect(wrongToken.outcome).toBe('not_found')
    // An ID or a token outside the forwarder's forms is unknown, before any read.
    expect(await r.receive(post('bad id!', '{}', signed('{}')))).toEqual(unknown)
    expect(await r.receive(post(webhook.id, '{}', signed('{}'), 't'.repeat(257)))).toEqual(unknown)
    expect(await store.listDeliveries(webhook.id)).toEqual([])
  })

  test('a body over 1 MiB is refused first, and GET is not a delivery method', async () => {
    const webhook = await makeWebhook()
    const { receiver: r } = receiver()
    expect((await r.receive(post(webhook.id, 'x'.repeat(1024 * 1024 + 1), []))).status).toBe(413)
    expect((await r.receive({ ...post(webhook.id, '', []), method: 'GET' })).status).toBe(405)
  })

  test('the rate limit comes before verification: unsigned requests use it up', async () => {
    const webhook = await makeWebhook()
    const { receiver: r } = receiver()
    for (let index = 0; index < 60; index++) expect((await r.receive(post(webhook.id, '{}', []))).status).toBe(401)
    const limited = await r.receive(post(webhook.id, '{}', signed('{}')))
    expect(limited.status).toBe(429)
    expect(limited.outcome).toBe('rate_limited')
  })

  test('a failed verification is 401 and the log keeps the step that failed', async () => {
    const webhook = await makeWebhook()
    const { receiver: r, ran } = receiver()
    const answer = await r.receive(post(webhook.id, '{}', [['x-hub-signature-256', 'sha256=00']]))
    expect(answer).toMatchObject({ status: 401, outcome: 'unverified' })
    const [summary] = await store.listDeliveries(webhook.id)
    expect(summary.outcome).toBe('unverified')
    expect((await store.readDelivery(summary.id))?.verificationFailure).toEqual({ step: 'signature_mismatch' })
    expect(ran).toEqual([])
  })

  test('a paused webhook answers 409 only after verification', async () => {
    const webhook = await makeWebhook({ enabled: false })
    const { receiver: r } = receiver()
    expect((await r.receive(post(webhook.id, '{}', []))).status).toBe(401)
    expect(await r.receive(post(webhook.id, '{}', signed('{}')))).toMatchObject({ status: 409, outcome: 'paused' })
    const adminPaused = await makeWebhook()
    const { receiver: admin } = receiver({ isPausedByAdmin: (id) => id === adminPaused.id })
    expect((await admin.receive(post(adminPaused.id, '{}', signed('{}')))).status).toBe(409)
  })

  test('an unverified organization webhook needs the policy; a local one does not', async () => {
    const none: WebhookVerification = { scheme: 'none', reason: 'The sender accepts only a URL: no header, no signing.' }
    const organization = await makeWebhook({ verification: none, organizationId: 'org-1' })
    const local = await makeWebhook({ verification: none })
    const { receiver: r } = receiver()
    expect(await r.receive(post(organization.id, '{}', []))).toMatchObject({ status: 403, outcome: 'not_allowed' })
    expect((await r.receive(post(local.id, '{}', []))).status).toBe(202)
    const { receiver: allowed } = receiver({ organizationRefusal: () => null })
    expect((await allowed.receive(post(organization.id, '{}', []))).status).toBe(202)
  })

  test('a refusal is checked on every delivery, so a rule changed after the save still holds (plans/030 §6.9)', async () => {
    const webhook = await makeWebhook({ organizationId: 'org-1' })
    let refusal: string | null = null
    const { receiver: r } = receiver({ organizationRefusal: () => refusal })
    expect((await r.receive(post(webhook.id, '{}', signed('{}')))).outcome).toBe('accepted')
    refusal = 'This organization does not allow its work to start on a personal computer.'
    expect(await r.receive(post(webhook.id, '{}', signed('{}')))).toMatchObject({ status: 403, outcome: 'not_allowed' })
  })

  test('a proven delivery ID runs once; an unproven one is ignored', async () => {
    const webhook = await makeWebhook()
    const { receiver: r, ran } = receiver()
    const receivedAt = String(Date.now() - 1000)
    const proof = proofModule.deliveryProof(FORWARDER_SECRET, 'host-1', webhook.id, 'fwd-1', receivedAt)
    const proven: [string, string][] = [['x-solus-hook-delivery-id', 'fwd-1'], ['x-solus-hook-received-at', receivedAt], ['x-solus-hook-proof', proof]]
    expect((await r.receive(post(webhook.id, '{}', signed('{}', proven)))).outcome).toBe('accepted')
    const again = await r.receive(post(webhook.id, '{}', signed('{}', proven)))
    expect(again).toMatchObject({ status: 202, outcome: 'duplicate' })
    const forged: [string, string][] = [['x-solus-hook-delivery-id', 'fwd-1'], ['x-solus-hook-received-at', receivedAt], ['x-solus-hook-proof', '0'.repeat(64)]]
    expect((await r.receive(post(webhook.id, '{}', signed('{}', forged)))).outcome).toBe('accepted')
    await new Promise((resolve) => setImmediate(resolve))
    expect(ran).toHaveLength(2)
    const [newest] = await store.listDeliveries(webhook.id)
    expect(newest.source).toBe('direct')
  })

  test('a replay key seen before is a duplicate', async () => {
    const webhook = await makeWebhook({ replayKey: '{{headers.x-github-delivery}}' })
    const { receiver: r } = receiver()
    expect((await r.receive(post(webhook.id, '{}', signed('{}', [['x-github-delivery', 'g-1']])))).outcome).toBe('accepted')
    expect((await r.receive(post(webhook.id, '{}', signed('{}', [['x-github-delivery', 'g-1']])))).outcome).toBe('duplicate')
    expect((await r.receive(post(webhook.id, '{}', signed('{}', [['x-github-delivery', 'g-2']])))).outcome).toBe('accepted')
  })
})

describe('webhook receiver route', () => {
  let http: HttpServer | null = null
  afterEach(async () => {
    if (http) await new Promise<void>((resolve) => http!.close(() => resolve()))
    http = null
  })

  test('every answer carries x-solus-hook-outcome, and the route is offered through the tunnel', async () => {
    const webhook = await makeWebhook()
    const { buildHttpServer } = await import("@solus/server/transport/http"); console.log("T2")
    const { receiver: r } = receiver()
    // Every request counts as a tunnel request: the route must be on the tunnel allowlist.
    const built = buildHttpServer({ host: '127.0.0.1', port: 0, webhookReceiver: r, isTunnelRequest: () => true })
    http = built.server
    await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    const base = `http://127.0.0.1:${address.port}`

    const accepted = await fetch(`${base}/hooks/${webhook.id}/${TOKEN}`, { method: 'POST', headers: Object.fromEntries(signed('{}')), body: '{}' })
    expect(accepted.status).toBe(202)
    expect(accepted.headers.get('x-solus-hook-outcome')).toBe('accepted')
    expect(await accepted.json()).toHaveProperty('deliveryId')

    const notFound = await fetch(`${base}/hooks/${webhook.id}/wrong`, { method: 'POST', body: '{}' })
    expect(notFound.status).toBe(404)
    expect(notFound.headers.get('x-solus-hook-outcome')).toBe('not_found')

    const get = await fetch(`${base}/hooks/${webhook.id}/${TOKEN}`)
    expect(get.status).toBe(405)
    expect(get.headers.get('x-solus-hook-outcome')).toBe('method_not_allowed')

    // Other routes stay closed on the tunnel.
    expect((await fetch(`${base}/upload`, { method: 'POST' })).status).toBe(404)

    const tooLarge = await fetch(`${base}/hooks/${webhook.id}/${TOKEN}`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.headers.get('x-solus-hook-outcome')).toBe('too_large')

  })
})
