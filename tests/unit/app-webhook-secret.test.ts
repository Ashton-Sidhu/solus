import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appDescriptorSchema } from '@solus/contracts/apps'
import type { AppRecord } from '@solus/server/data/apps/app-store'
import { DatabaseSync } from './helpers/bun-sqlite'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))
mock.module('@solus/server/project-config/projects-manifest', () => ({ listProjects: async () => [] }))

// docs/plans/apps.md §9.2, Webhooks: the host makes the signing secret of an
// app webhook, so the owner rotates it on the Manage page. A leaked secret
// must stop working at once, and Send test must sign with the secret the
// sender has now, through the same receiver as a real delivery.

const dataDir = mkdtempSync(join(tmpdir(), 'solus-app-webhook-secret-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
let store: typeof import('@solus/server/data/apps/app-store')

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/apps/app-store')
})

afterAll(async () => {
  await resetTestDatabase()
  process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const APP: AppRecord = {
  id: 'app-radar', organizationId: 'local', ownerKey: 'owner', slug: 'radar', name: 'Radar', description: '', customName: null, customDescription: null, colorHue: null, activeVersion: null,
  stopped: false, agentAccess: true, repository: '/nowhere', latestRevision: null, project: null, createdBy: { kind: 'system' }, webhookIds: {}, createdAt: 0, updatedAt: 0,
}
const DESCRIPTOR = appDescriptorSchema.parse({
  solusApp: 4,
  name: 'Radar',
  operations: [{ name: 'recordRelease', kind: 'mutation', description: '', input: {} }],
  webhooks: [{ name: 'release', verify: { scheme: 'hmac', algorithm: 'sha256', signedText: '{{body}}', signature: { source: { kind: 'header', name: 'x-hub-signature-256' }, format: { encoding: 'hex', prefix: 'sha256=' } } }, run: 'recordRelease' }],
})

test('a rotated secret replaces the old one at once, and Send test signs with the new one', async () => {
  const { AppWebhooks } = await import('@solus/server/apps/app-webhooks')
  const { createWebhookService } = await import('@solus/server/execution/webhooks/webhook-service')
  const { createWebhookReceiver } = await import('@solus/server/execution/webhooks/receiver')
  const { sendTestDelivery, testRequest } = await import('@solus/server/execution/webhooks/test-delivery')
  const { loadWebhook } = await import('@solus/server/data/webhooks/webhook-store')
  const { readWebhookSecrets } = await import('@solus/server/data/webhooks/webhook-secrets')

  await store.insertApp(APP)
  await store.insertVersion({
    appId: APP.id, number: 1, sourceCommit: 'a'.repeat(40), buildCommit: 'b'.repeat(40), descriptor: DESCRIPTOR,
    hasBackend: true, hasUi: false, state: 'building', error: null, buildLog: null, buildMs: null, message: 'v1', createdBy: { kind: 'system' }, createdAt: 1, activations: [],
  })
  await store.activateVersion(APP, 1, { kind: 'system' })
  const record = async () => {
    const app = await store.loadApp('local', APP.id)
    if (!app) throw new Error('The app is gone.')
    return app
  }
  const service = createWebhookService({
    urls: { cloudHost: () => null, cloudReady: () => false, publicUrl: () => 'https://hooks.example' },
    isPausedByAdmin: () => false,
    organizationRefusal: () => null,
  })
  const webhooks = new AppWebhooks({ record }, service)
  await webhooks.activated(await record(), DESCRIPTOR)

  const [before] = await webhooks.list(TEST_HANDLER_CTX, APP.id)
  const oldSecret = before?.secret ?? ''
  expect(oldSecret).not.toBe('')
  const [after] = await webhooks.rotateSecret(TEST_HANDLER_CTX, APP.id, 'release')
  expect(after?.secret).toBeTruthy()
  expect(after?.secret).not.toBe(oldSecret)
  await expect(webhooks.rotateSecret(TEST_HANDLER_CTX, APP.id, 'missing')).rejects.toThrow('This app has no webhook named missing.')

  const ran: string[] = []
  const receiver = createWebhookReceiver({ hostId: () => null, forwarderSecret: () => null, isPausedByAdmin: () => false, organizationRefusal: () => null, runDelivery: async (delivery) => { ran.push(delivery.deliveryId) } })
  const webhook = await loadWebhook(after?.webhookId ?? '')
  if (!webhook) throw new Error('The app webhook has no record.')
  const sent = await sendTestDelivery(receiver, webhook)
  expect(sent.outcome).toBe('pending')
  await new Promise((resolve) => setImmediate(resolve))
  expect(ran).toEqual([sent.id])

  // A sender that still signs with the old secret is refused.
  const old = testRequest(webhook, Buffer.from(oldSecret, 'utf8'), Date.now())
  const token = readWebhookSecrets(webhook.id)?.token ?? ''
  const refused = await receiver.receive({ method: 'POST', webhookId: webhook.id, token, headers: old.headers, query: [], body: old.body })
  expect(refused.status).toBe(401)
})
