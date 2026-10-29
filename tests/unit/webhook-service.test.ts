import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebhookCreateInput } from '@solus/contracts/webhooks'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/webhooks.md §2.2, §3.7, §5: the token is a credential, so a list
// never gives it; the URL follows the host's state (cloud, direct, or none); a
// secret goes to the secret store, never to a table; and verification is
// required, with the organization policy deciding the opt-out.

let dataDir: string
let serviceModule: typeof import('@solus/server/execution/webhooks/webhook-service')
let secrets: typeof import('@solus/server/data/webhooks/webhook-secrets')
let actorModule: typeof import('@solus/server/admission/actor')
let turnOrganization: typeof import('@solus/server/execution/sessions/turn-organization')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-webhook-service-'))
  process.env.SOLUS_DATA_DIR = dataDir
  serviceModule = await import('@solus/server/execution/webhooks/webhook-service')
  secrets = await import('@solus/server/data/webhooks/webhook-secrets')
  actorModule = await import('@solus/server/admission/actor')
  turnOrganization = await import('@solus/server/execution/sessions/turn-organization')
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

const github: WebhookCreateInput = {
  name: 'GitHub',
  verification: {
    scheme: 'hmac', algorithm: 'sha256', signedText: '{{body}}', secret: 'gh-secret',
    signature: { source: { kind: 'header', name: 'x-hub-signature-256' }, format: { encoding: 'hex', prefix: 'sha256=' } },
  },
  actions: [{ id: 'a1', type: 'send_to_session', sessionId: 's1', enabled: true, filters: [], template: 'Hi {{body.x}}' }],
}

type Policy = import('@solus/contracts/uplink').OrganizationPolicy
const OPEN: Policy = { allowsCloudHosts: true, allowsPersonalHosts: true, syncAllInsights: false }

/** A service whose save check is the real one of `turn-organization.ts`, over these policies and host category. */
function service(state: { cloud: boolean; publicUrl: string | null; origin?: string }, overrides: Partial<import('@solus/server/execution/webhooks/webhook-service').WebhookServiceDeps> = {}, policies: { [organizationId: string]: Policy } = {}, category: 'personal' | 'self-hosted' | 'managed' = 'personal') {
  const organizations = { policyFor: (id: string) => id === 'local' ? null : policies[id] ?? OPEN }
  return serviceModule.createWebhookService({
    urls: { cloudHost: () => ({ hostId: 'host-1', origin: state.origin ?? 'https://app.example.test' }), cloudReady: () => state.cloud, publicUrl: () => state.publicUrl },
    isPausedByAdmin: () => false,
    organizationRefusal: (organizationId, work) => turnOrganization.unattendedOrganizationRefusal(organizationId, organizations, work, category)?.message ?? null,
    ...overrides,
  })
}

const creator = () => actorModule.attributionOf(actorModule.HOST_ACTOR)

describe('webhook service', () => {
  test('create gives the URL with the token; a list and a plain read never do', async () => {
    const state = { cloud: false, publicUrl: 'https://me.example.dev' }
    const webhooks = service(state)
    const created = await webhooks.create(github, creator(), 'local')
    const token = secrets.readWebhookSecrets(created.id)!.token
    expect(created.url).toEqual({ mode: 'direct', path: `/hooks/${created.id}/${token}`, url: `https://me.example.dev/hooks/${created.id}/${token}` })
    const [listed] = await webhooks.list()
    expect(JSON.stringify(listed)).not.toContain(token)
    expect(listed.urlMode).toBe('direct')
    expect(JSON.stringify(await webhooks.read(created.id))).not.toContain(token)
    expect((await webhooks.readWithUrl(created.id))?.url.url).toContain(token)
    // The secret is in the secret store, never in the record.
    expect(JSON.stringify(listed)).not.toContain('gh-secret')
    expect(Buffer.from(secrets.readWebhookSecrets(created.id)!.secret!, 'base64').toString()).toBe('gh-secret')
  })

  test('the URL mode follows the host: cloud when linked with a forwarder, direct with a public URL, else none', async () => {
    const state = { cloud: true, publicUrl: 'https://me.example.dev' }
    const webhooks = service(state)
    const created = await webhooks.create(github, creator(), 'local')
    expect(created.url.mode).toBe('cloud')
    const token = secrets.readWebhookSecrets(created.id)!.token
    // The Cloud URL is on the Solus Cloud origin the host is registered with, with the token in the query only:
    // the forwarder's logs record the path and redact the query.
    expect(created.url.url).toBe(`https://app.example.test/hooks/host-1/${created.id}?t=${token}`)
    expect(new URL(created.url.url!).pathname).not.toContain(token)
    expect(new URL(created.url.url!).searchParams.get('t')).toBe(token)
    state.cloud = false
    expect((await webhooks.read(created.id))?.urlMode).toBe('direct')
    state.publicUrl = null
    const none = await webhooks.readWithUrl(created.id)
    expect(none?.url).toMatchObject({ mode: 'none', url: null })
  })

  test('the Direct URL keeps the token in the path; the receiver path is the same in both modes', async () => {
    const state = { cloud: true, publicUrl: 'https://me.example.dev' }
    const webhooks = service(state)
    const created = await webhooks.create(github, creator(), 'local')
    const token = secrets.readWebhookSecrets(created.id)!.token
    state.cloud = false
    const direct = await webhooks.readWithUrl(created.id)
    expect(direct?.url).toEqual({ mode: 'direct', path: `/hooks/${created.id}/${token}`, url: `https://me.example.dev/hooks/${created.id}/${token}` })
    expect(created.url.path).toBe(direct?.url.path)
  })

  test('a different Solus Cloud origin gives a different Cloud URL, and a copied one is marked as changed', async () => {
    const state: { cloud: boolean; publicUrl: string | null; origin?: string } = { cloud: true, publicUrl: null, origin: 'https://cloud-a.example.test/' }
    const webhooks = service(state)
    const created = await webhooks.create(github, creator(), 'local')
    const token = secrets.readWebhookSecrets(created.id)!.token
    expect(created.url.url).toBe(`https://cloud-a.example.test/hooks/host-1/${created.id}?t=${token}`)
    await webhooks.update(created.id, { copiedUrl: created.url.url! })
    state.origin = 'https://cloud-b.example.test'
    expect((await webhooks.readWithUrl(created.id))?.url.url).toBe(`https://cloud-b.example.test/hooks/host-1/${created.id}?t=${token}`)
    expect((await webhooks.read(created.id))?.urlChanged).toBe(true)
  })

  test('a Cloud URL copied in an earlier form is marked as changed', async () => {
    const { createHash } = await import('node:crypto')
    const store = await import('@solus/server/data/webhooks/webhook-store')
    const webhooks = service({ cloud: true, publicUrl: null })
    const created = await webhooks.create(github, creator(), 'local')
    const token = secrets.readWebhookSecrets(created.id)!.token
    // What the owner copied in an earlier form: another hostname, with the token in the path.
    const record = (await store.loadWebhook(created.id))!
    record.copiedUrlHash = createHash('sha256').update(`https://forwarder.example.test/host-1/${created.id}/${token}`).digest('hex')
    await store.saveWebhook(record)
    expect((await webhooks.read(created.id))?.urlChanged).toBe(true)
    // Copying the new form clears the mark.
    await webhooks.update(created.id, { copiedUrl: created.url.url! })
    expect((await webhooks.read(created.id))?.urlChanged).toBe(false)
  })

  test('a URL that changed since the owner copied it is marked, and Rotate stops the old token', async () => {
    const state = { cloud: true, publicUrl: 'https://me.example.dev' }
    const webhooks = service(state)
    const created = await webhooks.create(github, creator(), 'local')
    await webhooks.update(created.id, { copiedUrl: created.url.url! })
    expect((await webhooks.read(created.id))?.urlChanged).toBe(false)
    // The host unlinks: the cloud URL stops working and the direct URL replaces it.
    state.cloud = false
    expect((await webhooks.read(created.id))?.urlChanged).toBe(true)
    const rotated = await webhooks.rotate(created.id)
    expect(rotated?.url.url).not.toBe(created.url.url)
    expect(secrets.readWebhookSecrets(created.id)!.token).not.toBe(created.url.path.split('/').pop())
  })

  test('verification is required: a secret scheme needs its secret, and an organization needs the policy for the opt-out', async () => {
    const webhooks = service({ cloud: false, publicUrl: null })
    const { secret: _secret, ...withoutSecret } = github.verification
    await expect(webhooks.create({ ...github, verification: withoutSecret }, creator(), 'local')).rejects.toThrow('needs a secret')
    const none = { ...github, verification: { scheme: 'none' as const, reason: 'The sender accepts only a URL, no header.' } }
    await expect(webhooks.create(none, creator(), 'org-1')).rejects.toThrow('does not allow unverified webhooks')
    expect((await webhooks.create(none, creator(), 'local')).verification).toEqual(none.verification)
    const allowed = service({ cloud: false, publicUrl: null }, {}, { 'org-1': { ...OPEN, allowsUnverifiedWebhooks: true } })
    expect((await allowed.create(none, creator(), 'org-1')).organizationId).toBe('org-1')
  })

  test('a save is refused when the organization does not let its work start on a personal computer (plan §2.7)', async () => {
    const closed = { 'org-1': { ...OPEN, allowsPersonalHosts: false } }
    const laptop = service({ cloud: false, publicUrl: null }, {}, closed, 'personal')
    await expect(laptop.create(github, creator(), 'org-1')).rejects.toThrow('does not allow its work to start on a personal computer')
    // Local work and the organization's own machines are not affected.
    expect((await laptop.create(github, creator(), 'local')).organizationId).toBe('local')
    expect((await service({ cloud: false, publicUrl: null }, {}, closed, 'self-hosted').create(github, creator(), 'org-1')).organizationId).toBe('org-1')
  })

  test('an update that would start refused work is refused before anything is written; a paused webhook may be saved', async () => {
    const policies: { [organizationId: string]: Policy } = { 'org-1': { ...OPEN, allowsUnverifiedWebhooks: true } }
    const webhooks = service({ cloud: false, publicUrl: null }, {}, policies)
    const none = { scheme: 'none' as const, reason: 'The sender accepts only a URL, no header.' }
    const created = await webhooks.create({ ...github, verification: none }, creator(), 'org-1')
    policies['org-1'] = { ...OPEN, allowsUnverifiedWebhooks: false }
    await expect(webhooks.update(created.id, { name: 'Renamed' })).rejects.toThrow('does not allow unverified webhooks')
    expect((await webhooks.read(created.id))?.name).toBe('GitHub')
    // The owner can still pause it, and fix it with a scheme.
    expect((await webhooks.update(created.id, { enabled: false }))?.enabled).toBe(false)
    expect((await webhooks.update(created.id, { enabled: true, verification: github.verification }))?.verification.scheme).toBe('hmac')
  })

  test('an update without a secret keeps it for the same scheme, and a secretRef works once for its session', async () => {
    const refs = new Map([['ref-1', { value: 'from-card', sessionId: 'session-a' }]])
    const webhooks = service({ cloud: false, publicUrl: null }, {
      takeSecretRef: (ref, sessionId) => {
        const entry = refs.get(ref)
        if (!entry || entry.sessionId !== sessionId) return null
        refs.delete(ref)
        return entry.value
      },
    })
    const created = await webhooks.create(github, creator(), 'local')
    const { secret: _secret, ...signatureOnly } = github.verification
    await webhooks.update(created.id, { verification: signatureOnly })
    expect(Buffer.from(secrets.readWebhookSecrets(created.id)!.secret!, 'base64').toString()).toBe('gh-secret')
    await expect(webhooks.update(created.id, { verification: { ...signatureOnly, secretRef: 'ref-1' } }, 'session-b')).rejects.toThrow('secretRef is not valid')
    await webhooks.update(created.id, { verification: { ...signatureOnly, secretRef: 'ref-1' } }, 'session-a')
    expect(Buffer.from(secrets.readWebhookSecrets(created.id)!.secret!, 'base64').toString()).toBe('from-card')
    await expect(webhooks.update(created.id, { verification: { ...signatureOnly, secretRef: 'ref-1' } }, 'session-a')).rejects.toThrow('secretRef is not valid')
  })

  test('a base64 secret is decoded before it is saved; a Standard Webhooks secret decodes its whsec_ prefix', async () => {
    const webhooks = service({ cloud: false, publicUrl: null })
    const base64 = await webhooks.create({ ...github, verification: { ...github.verification, secret: Buffer.from([1, 2, 3]).toString('base64'), secretEncoding: 'base64' } }, creator(), 'local')
    expect(secrets.readWebhookSecrets(base64.id)!.secret).toBe(Buffer.from([1, 2, 3]).toString('base64'))
    const standard = await webhooks.create({ ...github, verification: { scheme: 'standard_webhooks', secret: `whsec_${Buffer.from('key').toString('base64')}` } }, creator(), 'local')
    expect(Buffer.from(secrets.readWebhookSecrets(standard.id)!.secret!, 'base64').toString()).toBe('key')
  })

  test('delete removes the record, its deliveries, and its secrets', async () => {
    const webhooks = service({ cloud: false, publicUrl: null })
    const created = await webhooks.create(github, creator(), 'local')
    expect(await webhooks.delete(created.id)).toBe(true)
    expect(await webhooks.read(created.id)).toBeNull()
    expect(secrets.readWebhookSecrets(created.id)).toBeNull()
  })
})
