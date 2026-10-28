import { describe, expect, test } from 'bun:test'
import type { Webhook } from '@solus/contracts/webhooks'
import {
  EMPTY_WEBHOOKS_VIEW,
  filterWebhookRows,
  parseWebhooksView,
  serializeWebhooksView,
  type WebhookRow,
  type WebhooksView,
} from '@solus/workspace-ui/components/webhooks/lib/webhooks-view'

function webhook(patch: Partial<Webhook>): Webhook {
  return {
    id: 'w1',
    organizationId: 'local',
    name: 'GitHub CI',
    enabled: true,
    pausedByAdmin: false,
    project: '/repo/app',
    verification: { scheme: 'standard_webhooks' },
    replayKey: null,
    actions: [],
    urlMode: 'cloud',
    urlChanged: false,
    lostCount: 0,
    lostAt: null,
    lastDelivery: null,
    deliveries24h: 0,
    createdBy: { kind: 'system' },
    ownerKey: 'owner-a',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

const rows: WebhookRow[] = [
  { serverId: 'host-a', webhook: webhook({ id: 'ok', lastDelivery: { at: 1, outcome: 'ran' } }) },
  { serverId: 'host-a', webhook: webhook({ id: 'partial', name: 'Linear', project: '/repo/other', lastDelivery: { at: 1, outcome: 'partial' } }) },
  { serverId: 'host-b', webhook: webhook({ id: 'unverified', name: 'Sentry', lastDelivery: { at: 1, outcome: 'unverified' }, urlMode: 'direct' }) },
  { serverId: 'host-b', webhook: webhook({ id: 'admin', name: 'Deploys', pausedByAdmin: true, enabled: false, organizationId: 'org-1', ownerKey: 'owner-b' }) },
  { serverId: 'host-b', webhook: webhook({ id: 'paused', name: 'Paused', enabled: false, lastDelivery: { at: 1, outcome: 'failed' } }) },
]

const ids = (view: Partial<WebhooksView>) => filterWebhookRows(rows, { ...EMPTY_WEBHOOKS_VIEW, ...view }).map((row) => row.webhook.id)

// The filters are kept in the page URL so a link opens the same view
// (docs/plans/webhooks.md §4): every field must survive the round trip.
describe('webhooks view in the URL', () => {
  test('every filter and the open webhook survive a round trip', () => {
    const view: WebhooksView = {
      query: 'ci & deploy',
      host: 'host-a',
      project: '/repo/app with space',
      state: 'admin-paused',
      outcome: 'failing',
      urlMode: 'direct',
      owner: 'owner-a',
      organization: 'org-1',
      open: { kind: 'webhook', serverId: 'host-a', webhookId: 'w/1' },
    }
    expect(parseWebhooksView(serializeWebhooksView(view))).toEqual(view)
  })

  test('a new webhook keeps its host choice, and the empty view is empty text', () => {
    const view: WebhooksView = { ...EMPTY_WEBHOOKS_VIEW, open: { kind: 'new', serverId: null } }
    expect(serializeWebhooksView(view)).toBe('new=1')
    expect(parseWebhooksView('new=1&on=host-b').open).toEqual({ kind: 'new', serverId: 'host-b' })
    expect(serializeWebhooksView(EMPTY_WEBHOOKS_VIEW)).toBe('')
  })

  test('an unknown value from an old link is dropped, not trusted', () => {
    const view = parseWebhooksView('state=gone&outcome=nope&mode=ftp&open=w1')
    expect(view.state).toBeNull()
    expect(view.outcome).toBeNull()
    expect(view.urlMode).toBeNull()
    // A webhook id without its host cannot name a webhook: two hosts can hold the same id.
    expect(view.open).toBeNull()
  })
})

describe('webhook table filters', () => {
  test('failing is a failed, partial, or unverified last delivery', () => {
    expect(ids({ outcome: 'failing' })).toEqual(['partial', 'unverified', 'paused'])
    expect(ids({ outcome: 'never' })).toEqual(['admin'])
  })

  test('state tells the owner pause from an admin pause', () => {
    expect(ids({ state: 'active' })).toEqual(['ok', 'partial', 'unverified'])
    expect(ids({ state: 'paused' })).toEqual(['paused'])
    expect(ids({ state: 'admin-paused' })).toEqual(['admin'])
  })

  test('host, project, URL mode, owner, organization, and text all narrow the rows', () => {
    expect(ids({ host: 'host-a' })).toEqual(['ok', 'partial'])
    expect(ids({ project: '/repo/other/' })).toEqual(['partial'])
    expect(ids({ urlMode: 'direct' })).toEqual(['unverified'])
    expect(ids({ owner: 'owner-b' })).toEqual(['admin'])
    expect(ids({ organization: 'org-1' })).toEqual(['admin'])
    expect(ids({ query: 'repo/other' })).toEqual(['partial'])
    expect(ids({ query: 'sentry' })).toEqual(['unverified'])
  })
})
