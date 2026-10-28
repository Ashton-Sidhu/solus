import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UplinkLinkManager } from '@solus/server/transport/uplink/link'
import { HostOrganizations } from '@solus/server/host/organizations'
import { hostOrganizationsResponseSchema, organizationPolicySchema } from '@solus/contracts/uplink'

// docs/plans/webhooks.md §2.3–§2.5, §2.7: the link answer gives the host a
// forwarder secret that proves forwarded deliveries, the hold switch lives in
// Solus cloud, the host asks for its held requests when its link comes online,
// and the organization facts name the webhooks an admin paused. The cloud repo
// copies this contract; these tests pin the shapes and paths it must match.

const DIRECTORY = 'https://app.example.test'
const HOST_ID = 'host_abc'
const registration = { hostId: HOST_ID, issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/jwks`, directoryUrl: DIRECTORY, generation: 1 }
const tunnel = { hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118 }
const FORWARDER_SECRET = `hfs_${'A'.repeat(52)}`

interface Call { method: string; url: string; body: unknown }

let dataDir = ''
const previousDataDir = process.env.SOLUS_DATA_DIR
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-webhook-uplink-'))
  process.env.SOLUS_DATA_DIR = dataDir
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

function plane(options: { drain?: () => Response } = {}) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, url, body })
    if (url.endsWith('/link') && method === 'POST') return Response.json({ tunnel, connectorToken: 'connector-1', forwarderSecret: FORWARDER_SECRET })
    if (url.endsWith('/link/hooks') && method === 'PUT') return Response.json({ holdWebhooks: body.holdWebhooks })
    if (url.endsWith('/hooks/drain') && method === 'POST') return options.drain?.() ?? Response.json({ lost: { 'wh-1': 3 } })
    return new Response('not found', { status: 404 })
  }
  return { calls, fetchImpl }
}

function manager(fetchImpl: typeof fetch, online: string[] = []) {
  return new UplinkLinkManager({
    registration: () => registration,
    controlToken: async () => 'control-1',
    proxiedPort: () => 34118,
    connector: { start: () => {}, stop: async () => {} },
    fetchImpl,
    onOnline: (reason) => online.push(reason),
  })
}

describe('webhook forwarder on the link', () => {
  test('the link answer gives the forwarder secret, kept in the secret store, never in host-link.json; its UTF-8 bytes are the key', async () => {
    const { fetchImpl } = plane()
    const link = manager(fetchImpl)
    expect(link.forwarderSecret()).toBeNull()
    await link.link()
    expect(link.forwarderSecret()).toEqual(Buffer.from(FORWARDER_SECRET, 'utf8'))
    expect(readFileSync(join(dataDir, 'host-link.json'), 'utf8')).not.toContain(FORWARDER_SECRET)
    expect(link.holdWebhooks()).toBe(true)
  })

  test('the hold switch is a PUT to /v1/hosts/:id/link/hooks; not linked, it is null', async () => {
    const { calls, fetchImpl } = plane()
    const link = manager(fetchImpl)
    expect(link.holdWebhooks()).toBeNull()
    await link.link()
    expect(await link.setHoldWebhooks(false)).toBe(false)
    expect(calls.at(-1)).toEqual({ method: 'PUT', url: `${DIRECTORY}/v1/hosts/${HOST_ID}/link/hooks`, body: { holdWebhooks: false } })
    expect(link.holdWebhooks()).toBe(false)
  })

  test('the drain is a POST of {} to /v1/hosts/:id/hooks/drain, and answers one lost count for each webhook', async () => {
    const { calls, fetchImpl } = plane()
    const link = manager(fetchImpl)
    expect(await link.drainWebhooks()).toBeNull()
    await link.link()
    expect(await link.drainWebhooks()).toEqual({ kind: 'drained', lost: { 'wh-1': 3 } })
    expect(calls.at(-1)).toEqual({ method: 'POST', url: `${DIRECTORY}/v1/hosts/${HOST_ID}/hooks/drain`, body: {} })
  })

  test('an inbox that does not answer means ask again after retry-after; a control plane without the forwarder answers 404', async () => {
    const busy = manager(plane({ drain: () => Response.json({ error: 'hook_inbox_unavailable' }, { status: 503, headers: { 'retry-after': '60' } }) }).fetchImpl)
    await busy.link()
    expect(await busy.drainWebhooks()).toEqual({ kind: 'retry', afterMs: 60_000 })
    const old = manager(plane({ drain: () => new Response('', { status: 404 }) }).fetchImpl)
    await old.link()
    expect(await old.drainWebhooks()).toBeNull()
  })

  test('the hold switch of a host that Solus cloud does not see as linked answers 409 host_not_linked', async () => {
    const fetchImpl: typeof fetch = async (input, init) => String(input).endsWith('/link/hooks')
      ? Response.json({ error: 'host_not_linked' }, { status: 409 })
      : plane().fetchImpl(input, init)
    const link = manager(fetchImpl)
    await link.link()
    await expect(link.setHoldWebhooks(false)).rejects.toThrow('not linked')
  })

  test('the host asks for a drain when its link comes online: first at server start, then each time the tunnel registers again', async () => {
    const { fetchImpl } = plane()
    const online: string[] = []
    const link = manager(fetchImpl, online)
    await link.link()
    link.handleConnectorObservation({ observed: 'online' })
    link.handleConnectorObservation({ observed: 'online' })
    link.handleConnectorObservation({ observed: 'offline' })
    link.handleConnectorObservation({ observed: 'online' })
    expect(online).toEqual(['server_start', 'tunnel_registered'])
  })
})

describe('organization facts for webhooks', () => {
  test('a policy from an older control plane does not allow unverified webhooks', () => {
    expect(organizationPolicySchema.parse({ allowsCloudHosts: true, allowsPersonalHosts: true, syncAllInsights: false }).allowsUnverifiedWebhooks).toBeUndefined()
  })

  test('the facts read gives the paused webhook IDs and the unverified policy', async () => {
    const answer = hostOrganizationsResponseSchema.parse({
      hostId: HOST_ID, category: 'personal', owner: null,
      organizations: [
        { organizationId: 'org-1', name: 'Acme', shared: false, policy: { allowsCloudHosts: true, allowsPersonalHosts: true, syncAllInsights: false, allowsUnverifiedWebhooks: true } },
        { organizationId: 'org-2', name: 'Beta', shared: false, policy: { allowsCloudHosts: true, allowsPersonalHosts: true, syncAllInsights: false, allowsUnverifiedWebhooks: false } },
      ],
      pausedWebhookIds: ['wh-paused'],
    })
    const organizations = new HostOrganizations({
      registration: () => registration,
      credential: () => ({ hostAccessToken: async () => 'control-1' }),
      fetchImpl: async () => Response.json(answer),
      setTimeoutFn: (() => 0) as never,
      clearTimeoutFn: (() => {}) as never,
    })
    await organizations.refresh()
    expect(organizations.isWebhookPausedByAdmin('wh-paused')).toBe(true)
    expect(organizations.isWebhookPausedByAdmin('wh-other')).toBe(false)
    expect(organizations.allowsUnverifiedWebhooks('org-1')).toBe(true)
    expect(organizations.allowsUnverifiedWebhooks('org-2')).toBe(false)
  })
})
