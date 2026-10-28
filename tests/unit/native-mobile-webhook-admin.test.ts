import { describe, expect, test } from 'bun:test'
import type { WebhookAdminEntry } from '@solus/contracts/webhook-admin'
import type { HostRoute } from '@solus/contracts/host-routes'
import { HostConnections } from '../../apps/mobile/src/features/hosts/host-connections'
import { HostRegistry } from '../../apps/mobile/src/features/hosts/host-registry'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/src/platform/ports'
import {
  ADMIN_FAILED_TEXT,
  adminActionErrorText,
  adminControl,
  adminRefusalText,
  adminStateLabel,
  adminWebhookRow,
  organizationWebhooksState,
  sortAdminEntries,
} from '../../apps/mobile/src/features/webhooks/webhook-admin'
import { PAUSED_BY_ADMIN_TEXT } from '../../apps/mobile/src/features/webhooks/webhooks'
import { FakeApi, FakeTransport, ManualTimers } from './helpers/native-mobile-fakes'

// The Organization view of the phone's Webhooks screen (docs/plans/webhooks.md §2.7).
// These pin what an organization admin reads and can do: a refusal never reads as an
// empty list, an admin pause is the only thing an admin resumes, a row names its owner
// even without a name, and the view reads the organization's Solus API, not a host.

const NOW = Date.UTC(2026, 9, 28, 12)

function entry(overrides: Partial<WebhookAdminEntry> = {}): WebhookAdminEntry {
  return {
    hostId: 'host-1',
    hostLabel: 'Build box',
    webhookId: 'wh-1',
    name: 'GitHub',
    ownerUserId: 'user-7',
    ownerName: 'Ada',
    projectName: '/srv/code/solus',
    urlMode: 'cloud',
    state: 'active',
    actionTypes: ['start_session'],
    adminPause: null,
    lastDelivery: null,
    deliveriesLast24Hours: 0,
    ...overrides,
  }
}

describe('refusals and failures', () => {
  test('each refusal has its own text', () => {
    expect(adminRefusalText('not_organization_admin')).toBe('Only an organization admin can see this view.')
    expect(adminRefusalText('host_not_of_organization')).toBe('That host does not deliver to this organization.')
  })

  test('a refused read is not an empty list', () => {
    expect(organizationWebhooksState({ ok: false, error: 'not_organization_admin' })).toEqual({
      kind: 'refused',
      message: 'Only an organization admin can see this view.',
    })
    expect(organizationWebhooksState({ ok: true, value: { webhooks: [] } })).toEqual({ kind: 'loaded', webhooks: [] })
  })

  test('a Pause that threw says the Solus API did not answer; a refused one says why', () => {
    expect(adminActionErrorText('pause', null)).toBe(`Not paused. ${ADMIN_FAILED_TEXT}`)
    expect(adminActionErrorText('resume', { ok: false, error: 'host_not_of_organization' }))
      .toBe('Not resumed. That host does not deliver to this organization.')
  })
})

describe('state and control', () => {
  test('an admin pause wins over the owner switch, and only it gives Resume', () => {
    const adminPaused = entry({ state: 'paused', adminPause: { pausedByUserId: 'admin-1', pausedAt: NOW } })
    expect(adminStateLabel(adminPaused)).toBe(PAUSED_BY_ADMIN_TEXT)
    expect(adminControl(adminPaused)).toBe('resume')

    const ownerPaused = entry({ state: 'paused' })
    expect(adminStateLabel(ownerPaused)).toBe('Paused by owner')
    // The owner's pause is the owner's to undo: an admin can only add an admin pause.
    expect(adminControl(ownerPaused)).toBe('pause')

    expect(adminStateLabel(entry())).toBe('Active')
    expect(adminControl(entry())).toBe('pause')
  })
})

describe('rows', () => {
  test('a row names host, project, owner, last delivery, and the 24-hour count', () => {
    const row = adminWebhookRow(entry({
      lastDelivery: { deliveryId: 'd-1', receivedAt: NOW - 5 * 60_000, outcome: 'failed', actionStatuses: ['failed'] },
      deliveriesLast24Hours: 3,
    }), 'org-1', NOW)
    expect(row.title).toBe('GitHub')
    expect(row.lines.map((line) => line.text)).toEqual([
      'Build box · solus',
      'Owner: Ada',
      'Last delivery: Failed, 5m ago',
      '3 deliveries in 24 hours',
    ])
    expect(row.lines[2]!.tone).toBe('danger')
    expect(row.ref).toEqual({ organizationId: 'org-1', hostId: 'host-1', webhookId: 'wh-1' })
  })

  test('an owner with no name shows by account id; an outcome this app does not know shows as written', () => {
    const row = adminWebhookRow(entry({
      ownerName: null,
      projectName: null,
      lastDelivery: { deliveryId: 'd-1', receivedAt: NOW, outcome: 'held_back', actionStatuses: [] },
    }), 'org-1', NOW)
    expect(row.lines.map((line) => line.text)).toEqual([
      'Build box',
      'Owner: user-7',
      'Last delivery: held_back, now',
      'No deliveries in 24 hours',
    ])
    expect(row.lines[2]!.tone).toBe('muted')
  })

  test('one webhook id on two hosts is two rows, in a stable order', () => {
    const a = entry({ hostId: 'host-b' })
    const b = entry({ hostId: 'host-a' })
    const c = entry({ name: 'Alerts', hostId: 'host-c' })
    expect(sortAdminEntries([a, b, c]).map((item) => item.hostId)).toEqual(['host-c', 'host-a', 'host-b'])
    expect(adminWebhookRow(a, 'org-1', NOW).key).not.toBe(adminWebhookRow(b, 'org-1', NOW).key)
  })
})

describe('the Solus API connection', () => {
  function world(routes: readonly HostRoute[]) {
    const storage = memoryKeyValueStore()
    const timers = new ManualTimers()
    const transports: FakeTransport[] = []
    const connections = new HostConnections({
      registry: new HostRegistry(storage, memorySecretStore()),
      createTransport: (options) => {
        const transport = new FakeTransport(options, new FakeApi())
        transports.push(transport)
        return transport
      },
      hostAccessToken: async () => 'host-grant',
      isSignedOut: () => false,
      dialOrganizationId: () => null,
      organizationId: () => 'org-1',
      solusApiRoutes: () => routes,
      solusApiAccessToken: async () => 'api-grant',
      fetch: (async () => { throw new Error('unreachable') }) as unknown as typeof fetch,
      clientVersion: '1.4.0',
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    })
    return { connections, transports }
  }

  test('no tunnel route listed: there is no connection, so the view shows the failed state', () => {
    const { connections, transports } = world([{ kind: 'lan', url: 'http://10.0.0.2:4000' }])
    expect(connections.solusApi('org-1')).toBeNull()
    expect(transports).toHaveLength(0)
  })

  test('it dials the tunnel as workspace:<organization> with an API grant, once', async () => {
    const { connections, transports } = world([{ kind: 'tunnel', url: 'https://org-1.api.solus.test' }])
    const connection = connections.solusApi('org-1')
    expect(connection?.hostId).toBe('workspace:org-1')
    expect(connections.solusApi('org-1')).toBe(connection)
    expect(transports).toHaveLength(1)
    const options = transports[0]!.options
    expect(options.serverUrl).toBe('https://org-1.api.solus.test')
    expect(options.sessionToken).toBe('')
    expect(options.dialOrganizationId?.()).toBe('org-1')
    expect(await options.grants?.acquire()).toBe('api-grant')
  })
})
