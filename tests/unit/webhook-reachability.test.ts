import { describe, expect, test } from 'bun:test'
import { REACHABILITY_TEXT, unlinkWebhookWarning, webhookReachabilityText } from '@solus/workspace-ui/components/webhooks/lib/webhook-reachability'

// The editor must say honestly what happens to a request while the host is
// away (docs/plans/webhooks.md §4). A wrong text makes a user trust a URL
// that drops requests.
describe('webhook reachability text', () => {
  test('a linked host that holds requests says they wait in Solus Cloud', () => {
    expect(webhookReachabilityText('cloud', true, 'personal')).toBe('Requests wait in Solus Cloud for up to 24 hours while this host is offline.')
    expect(webhookReachabilityText('cloud', true, 'managed')).toBe(REACHABILITY_TEXT.heldWhileOffline)
  })

  test('a linked host without holding says requests fail; a personal computer names sleep', () => {
    expect(webhookReachabilityText('cloud', false, 'self-hosted')).toBe('Requests fail while this host is offline.')
    expect(webhookReachabilityText('cloud', false, undefined)).toBe(REACHABILITY_TEXT.failWhileOffline)
    expect(webhookReachabilityText('cloud', false, 'personal')).toBe('Requests fail while this computer sleeps. Turn on holding, or use a cloud machine.')
  })

  test('a direct URL and no URL do not depend on the hold setting', () => {
    for (const hold of [true, false, null, undefined]) {
      expect(webhookReachabilityText('direct', hold, 'personal')).toBe('Solus cannot hold requests for this host. Keep it reachable at its public URL.')
      expect(webhookReachabilityText('none', hold, 'personal')).toBe('Link this host to Solus Cloud, or set its public URL.')
    }
  })

  test('a cloud URL whose host settings are not read yet has no text, not a guess', () => {
    expect(webhookReachabilityText('cloud', undefined, 'personal')).toBeNull()
  })
})

describe('unlink warning', () => {
  test('names the count of cloud-URL webhooks, and is absent when there are none', () => {
    expect(unlinkWebhookWarning(0)).toBeNull()
    expect(unlinkWebhookWarning(3)).toBe('3 webhooks use the Solus Cloud URL. Their senders must get the new URL.')
    expect(unlinkWebhookWarning(1)).toBe('1 webhook uses the Solus Cloud URL. Its sender must get the new URL.')
  })
})
