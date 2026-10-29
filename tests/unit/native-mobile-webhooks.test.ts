import { describe, expect, test } from 'bun:test'
import type { HostWebhookSettings, Webhook, WebhookDeliveryOutcome, WebhookDeliverySummary, WebhookWithUrl } from '@solus/contracts/webhooks'
import {
  appendDeliveries,
  copyTarget,
  deliveries24hText,
  hostUrlMode,
  isFailingOutcome,
  lastDeliveryText,
  lostText,
  pauseControl,
  projectName,
  publicUrlPatch,
  reachabilityText,
  sortDeliveries,
  sortWebhooks,
  unverifiedReason,
  webhookStateLabel,
  withDelivery,
  withoutWebhook,
  withWebhook,
} from '../../apps/mobile/src/features/webhooks/webhooks'

// The phone's Webhooks screens (docs/plans/webhooks.md §4, mobile version 1).
// These pin what a person reads and can do: the reachability text must not
// promise holding the host does not give, an admin pause has no Resume, Copy
// works only with the owner's URL, and deliveries stay newest first.

function webhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: 'wh-1',
    organizationId: 'local',
    name: 'GitHub',
    enabled: true,
    pausedByAdmin: false,
    project: '/Users/me/code/solus',
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
    ownerKey: 'local',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function delivery(id: string, arrivedAt: number, overrides: Partial<WebhookDeliverySummary> = {}): WebhookDeliverySummary {
  return { id, webhookId: 'wh-1', receivedAt: arrivedAt, arrivedAt, source: 'direct', outcome: 'ran', reason: null, replayOf: null, ...overrides }
}

const linked = (hold: boolean): HostWebhookSettings => ({ publicUrl: null, holdWhileOffline: hold, linked: true })
const unlinked = (publicUrl: string | null): HostWebhookSettings => ({ publicUrl, holdWhileOffline: null, linked: false })

describe('reachability text', () => {
  test('each URL mode and hold state gets the text of plan §4', () => {
    expect(reachabilityText('cloud', linked(true), false)).toBe('Requests wait in Solus Cloud for up to 24 hours while this host is offline.')
    expect(reachabilityText('cloud', linked(false), false)).toBe('Requests fail while this host is offline.')
    expect(reachabilityText('cloud', linked(false), true)).toBe('Requests fail while this computer sleeps. Turn on holding, or use a cloud machine.')
    expect(reachabilityText('direct', unlinked('https://me.example'), true)).toBe('Solus cannot hold requests for this host. Keep it reachable at its public URL.')
    expect(reachabilityText('none', unlinked(null), false)).toBe('Link this host to Solus Cloud, or set its public URL.')
  })

  test('a cloud URL makes no promise until the hold state is read', () => {
    expect(reachabilityText('cloud', null, true)).toBeNull()
    // The URL modes that do not depend on holding still say how the host is reached.
    expect(reachabilityText('direct', null, false)).not.toBeNull()
    expect(reachabilityText('none', null, false)).not.toBeNull()
  })

  test('the host URL mode follows the link first, then the public URL', () => {
    expect(hostUrlMode({ publicUrl: 'https://me.example', holdWhileOffline: true, linked: true })).toBe('cloud')
    expect(hostUrlMode(unlinked('https://me.example'))).toBe('direct')
    expect(hostUrlMode(unlinked(null))).toBe('none')
  })
})

describe('state and pause', () => {
  test('an admin pause shows its own label and offers no Resume', () => {
    const paused = webhook({ enabled: true, pausedByAdmin: true })
    expect(webhookStateLabel(paused)).toBe('Paused by organization admin')
    expect(pauseControl(paused)).toBe('none')
  })

  test('the owner pauses an active webhook and resumes a paused one', () => {
    expect([webhookStateLabel(webhook()), pauseControl(webhook())]).toEqual(['Active', 'pause'])
    expect([webhookStateLabel(webhook({ enabled: false })), pauseControl(webhook({ enabled: false }))]).toEqual(['Paused', 'resume'])
  })

  test('an unverified webhook gives its reason; a verified one gives none', () => {
    expect(unverifiedReason(webhook({ verification: { scheme: 'none', reason: 'The sender accepts only a URL.' } }))).toBe('The sender accepts only a URL.')
    expect(unverifiedReason(webhook())).toBeNull()
  })
})

describe('Copy', () => {
  test('only the owner read with a URL can be copied', () => {
    const withUrl: WebhookWithUrl = { ...webhook(), url: { mode: 'cloud', path: '/hooks/wh-1/t', url: 'https://hooks.solus.sh/h/wh-1?t=t' } }
    expect(copyTarget(withUrl)).toEqual({ kind: 'url', url: 'https://hooks.solus.sh/h/wh-1?t=t' })
    expect(copyTarget({ ...withUrl, url: { mode: 'none', path: '/hooks/wh-1/t', url: null } })).toEqual({ kind: 'no_url' })
    expect(copyTarget(webhook())).toEqual({ kind: 'not_owner' })
    expect(copyTarget(null)).toEqual({ kind: 'missing' })
  })
})

describe('host public URL', () => {
  test('empty clears it, an http or https URL sets it, other text is refused', () => {
    expect(publicUrlPatch('  ')).toEqual({ ok: true, publicUrl: null })
    expect(publicUrlPatch(' https://me.example/ ')).toEqual({ ok: true, publicUrl: 'https://me.example' })
    expect(publicUrlPatch('http://10.0.0.2:4000')).toEqual({ ok: true, publicUrl: 'http://10.0.0.2:4000' })
    expect(publicUrlPatch('me.example').ok).toBe(false)
    expect(publicUrlPatch('ftp://me.example').ok).toBe(false)
  })
})

describe('lists', () => {
  test('webhooks are in name order, and a saved one takes its place', () => {
    const list = sortWebhooks([webhook({ id: 'b', name: 'Sentry' }), webhook({ id: 'a', name: 'GitHub' })])
    expect(list.map((entry) => entry.id)).toEqual(['a', 'b'])
    const renamed = withWebhook(list, webhook({ id: 'a', name: 'Zendesk' }))
    expect(renamed.map((entry) => [entry.id, entry.name])).toEqual([['b', 'Sentry'], ['a', 'Zendesk']])
    expect(withoutWebhook(renamed, 'b').map((entry) => entry.id)).toEqual(['a'])
  })

  test('deliveries are newest first; a later summary of the same delivery replaces it', () => {
    const list = sortDeliveries([delivery('d1', 100), delivery('d3', 300), delivery('d2', 200)])
    expect(list.map((entry) => entry.id)).toEqual(['d3', 'd2', 'd1'])
    const finished = withDelivery(list, delivery('d2', 200, { outcome: 'failed' }))
    expect(finished.map((entry) => [entry.id, entry.outcome])).toEqual([['d3', 'ran'], ['d2', 'failed'], ['d1', 'ran']])
    expect(withDelivery(list, delivery('d4', 400))[0]!.id).toBe('d4')
  })

  test('an older page goes below and does not repeat a delivery', () => {
    const shown = [delivery('d3', 300), delivery('d2', 200)]
    expect(appendDeliveries(shown, [delivery('d2', 200), delivery('d1', 100)]).map((entry) => entry.id)).toEqual(['d3', 'd2', 'd1'])
  })
})

describe('row text', () => {
  test('the lost count names the requests and says they were not verified', () => {
    expect(lostText(0)).toBeNull()
    expect(lostText(1)).toBe('1 request was lost while this host was offline (not verified).')
    expect(lostText(3)).toBe('3 requests were lost while this host was offline (not verified).')
  })

  test('the last delivery gives its outcome and age; failing outcomes are marked', () => {
    const now = Date.parse('2026-10-28T12:00:00Z')
    expect(lastDeliveryText(null, now)).toBe('No deliveries yet')
    expect(lastDeliveryText({ at: now - 2 * 60 * 60 * 1000, outcome: 'partial' }, now)).toBe('Last delivery: Partly failed, 2h ago')
    expect(lastDeliveryText({ at: now, outcome: 'ran' }, now)).toBe('Last delivery: Ran, now')
    const failing: WebhookDeliveryOutcome[] = ['partial', 'failed', 'unverified', 'not_allowed']
    const quiet: WebhookDeliveryOutcome[] = ['ran', 'filtered', 'duplicate', 'pending', 'paused']
    expect(failing.every(isFailingOutcome)).toBe(true)
    expect(quiet.some(isFailingOutcome)).toBe(false)
  })

  test('counts and project names read plainly', () => {
    expect([deliveries24hText(0), deliveries24hText(1), deliveries24hText(5)]).toEqual(['No deliveries in 24 hours', '1 delivery in 24 hours', '5 deliveries in 24 hours'])
    expect([projectName('/Users/me/code/solus/'), projectName('C:\\code\\app'), projectName(null)]).toEqual(['solus', 'app', null])
  })
})
