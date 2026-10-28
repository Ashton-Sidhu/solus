import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebhookAdminIntake, WebhookAdminPort } from '@solus/contracts/webhook-admin'
import type { WebhookDelivery } from '@solus/contracts/webhooks'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/webhooks.md §2.7: organization admins see the organization's webhooks
// on every host and can pause them. The host mirrors metadata and delivery
// summaries through its delivery queue — never a token, a body, or a prompt — and
// the Solus API gives them to Solus Cloud's `webhookAdmin` port for the host and
// organization the runner proved. The admin rule is the port's.

let dataDir: string
let mirror: typeof import('@solus/server/sync/mirror/webhook-mirror')
let queue: typeof import('@solus/server/sync/delivery-queue')
let intake: typeof import('@solus/server/sync/runner-intake')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-webhook-admin-'))
  process.env.SOLUS_DATA_DIR = dataDir
  mirror = await import('@solus/server/sync/mirror/webhook-mirror')
  queue = await import('@solus/server/sync/delivery-queue')
  intake = await import('@solus/server/sync/runner-intake')
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

const webhook = {
  id: 'wh-1', organizationId: 'org-1', ownerKey: 'acct_alice', name: 'GitHub', project: '/home/alice/acme-api',
  urlMode: 'cloud' as const, enabled: true, actions: [{ type: 'start_session' as const }, { type: 'run_automation' as const }], updatedAt: 1_000,
}
const destination = { organizationId: 'org-1', actorUserId: 'acct_alice' }

describe('host mirror of organization webhooks', () => {
  test('a save queues the metadata for the organization, delivered by the owner; nothing secret is in it', () => {
    mirror.mirrorWebhook(webhook, { registered: true })
    const [item] = queue.listDelivery(destination, 10)
    expect(item.kind).toBe('webhooks')
    expect(item.payload).toEqual({ webhooks: [{
      webhookId: 'wh-1', name: 'GitHub', ownerUserId: 'acct_alice', projectName: 'acme-api', urlMode: 'cloud',
      state: 'active', actionTypes: ['start_session', 'run_automation'], changedAt: 1_000,
    }] })
  })

  test('a delete queues a removal newer than the last save', () => {
    mirror.mirrorWebhook({ ...webhook, enabled: false }, { deleted: true, registered: true, now: 5_000 })
    expect(queue.listDelivery(destination, 10)[0].payload).toMatchObject({ webhooks: [{ state: 'paused', deleted: true, changedAt: 5_000 }] })
  })

  test('a delivery queues its time, outcome, and action statuses only', () => {
    const delivery: WebhookDelivery = {
      id: 'd-1', webhookId: 'wh-1', receivedAt: 2_000, arrivedAt: 2_100, source: 'forwarded', outcome: 'partial', reason: 'Some actions failed.', replayOf: null,
      request: { method: 'POST', headers: [['x-github-event', 'push']], query: [], body: '{"secret":"body"}', bodyIsBase64: false }, verificationFailure: null,
      actions: [{ actionId: 'a', type: 'start_session', status: 'started', filters: [], missing: [], prompt: 'rendered prompt' }, { actionId: 'b', type: 'run_automation', status: 'busy', filters: [], missing: [] }],
    }
    mirror.mirrorWebhookDelivery(webhook, delivery, { registered: true })
    const payload = queue.listDelivery(destination, 10)[0].payload
    expect(payload).toEqual({ deliveries: [{ webhookId: 'wh-1', deliveryId: 'd-1', receivedAt: 2_000, outcome: 'partial', actionStatuses: ['started', 'busy'] }] })
    expect(JSON.stringify(payload)).not.toContain('rendered prompt')
    expect(JSON.stringify(payload)).not.toContain('body')
  })

  test('a Local webhook, or a host that is not registered, sends nothing', () => {
    mirror.mirrorWebhook({ ...webhook, organizationId: 'local' }, { registered: true })
    mirror.mirrorWebhook(webhook, { registered: false })
    expect(queue.deliveryDestinations()).toEqual([])
  })
})

describe('Solus API intake of webhook records', () => {
  const runner = { kind: 'runner' as const, hostId: 'host-1', organizationId: 'org-1', ownerUserId: 'acct_alice', deviceId: 'host-1', expiresAt: Number.MAX_SAFE_INTEGER, deviceLabel: 'host-1' }
  const item = (seq: number) => ({ seq, kind: 'webhooks' as const, payload: { webhooks: [{ webhookId: 'wh-1', name: 'GitHub', ownerUserId: 'acct_alice', projectName: null, urlMode: 'cloud', state: 'active', actionTypes: ['start_session'], changedAt: 1, token: 'must-not-pass' }] } })

  function port(answer: Awaited<ReturnType<WebhookAdminPort['intake']>>) {
    const calls: WebhookAdminIntake[] = []
    const value: WebhookAdminPort = {
      intake: async (input) => { calls.push(input); return answer },
      list: async () => ({ ok: false, error: 'not_organization_admin' }),
      pause: async () => ({ ok: true, value: null }),
      resume: async () => ({ ok: true, value: null }),
    }
    return { calls, value }
  }

  test('the item goes to the port for the host and organization the runner proved; an unknown field is dropped', async () => {
    const { calls, value } = port({ ok: true, value: null })
    const answer = await intake.applyRunnerDelivery(runner, { hostId: 'host-1', items: [item(1)] }, { webhookAdmin: value })
    expect(answer).toEqual({ lastSeq: 1, failed: [] })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ hostId: 'host-1', organizationId: 'org-1', deliveries: [] })
    expect(JSON.stringify(calls[0])).not.toContain('must-not-pass')
  })

  test('a refusal is permanent: the item is named and skipped', async () => {
    const { value } = port({ ok: false, error: 'host_not_of_organization' })
    const answer = await intake.applyRunnerDelivery(runner, { hostId: 'host-1', items: [item(1)] }, { webhookAdmin: value })
    expect(answer.lastSeq).toBe(1)
    expect(answer.failed[0].error).toContain('host_not_of_organization')
  })

  test('a kind this service does not know is skipped and named; the known kinds of the batch still apply', async () => {
    const { calls, value } = port({ ok: true, value: null })
    const answer = await intake.applyRunnerDelivery(runner, { hostId: 'host-1', items: [item(1), { seq: 2, kind: 'kind_from_a_newer_release', payload: { secret: 'never logged' } }, item(3)] }, { webhookAdmin: value })
    expect(answer).toEqual({ lastSeq: 3, failed: [{ seq: 2, error: 'unknown_kind:kind_from_a_newer_release' }] })
    expect(calls).toHaveLength(2)
  })

  test('the runner route parses a batch with an unknown kind instead of refusing it whole', async () => {
    const { runnerDeliverRequestSchema } = await import('@solus/server/sync/runner-protocol')
    expect(runnerDeliverRequestSchema.safeParse({ hostId: 'h', items: [{ seq: 1, kind: 'kind_from_a_newer_release', payload: {} }] }).success).toBe(true)
  })

  test('a service without the port keeps nothing and does not stop the queue', async () => {
    expect(await intake.applyRunnerDelivery(runner, { hostId: 'host-1', items: [item(1)] }, {})).toEqual({ lastSeq: 1, failed: [] })
  })
})

describe('admin RPC handlers', () => {
  test('they pass the member behind the call to the port; any other caller is refused', async () => {
    const { registerWebhookAdminHandlers } = await import('@solus/server/transport/handlers/webhook-admin-handlers')
    const handlers = new Map<string, (args: unknown[], ctx: { principal: { kind: string; userId?: string } }) => Promise<unknown>>()
    const seen: string[] = []
    registerWebhookAdminHandlers({ register: (method: string, handler: never) => handlers.set(method, handler) } as never, {
      intake: async () => ({ ok: true, value: null }),
      list: async ({ userId, organizationId }) => { seen.push(`list:${userId}:${organizationId}`); return { ok: true, value: { organizationId, webhooks: [] } } },
      pause: async ({ userId, webhookId }) => { seen.push(`pause:${userId}:${webhookId}`); return { ok: true, value: null } },
      resume: async () => ({ ok: true, value: null }),
    })
    const member = { principal: { kind: 'org-member', userId: 'acct_admin' } }
    expect(await handlers.get('webhookAdminList')!(['org-1'], member)).toEqual({ ok: true, value: { organizationId: 'org-1', webhooks: [] } })
    expect(await handlers.get('webhookAdminPause')!([{ organizationId: 'org-1', hostId: 'host-1', webhookId: 'wh-1' }], member)).toEqual({ ok: true, value: null })
    expect(await handlers.get('webhookAdminList')!(['org-1'], { principal: { kind: 'runner' } })).toEqual({ ok: false, error: 'not_organization_admin' })
    expect(seen).toEqual(['list:acct_admin:org-1', 'pause:acct_admin:wh-1'])
  })
})
