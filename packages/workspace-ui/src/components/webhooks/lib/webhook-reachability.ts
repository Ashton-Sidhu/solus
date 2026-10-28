import type { HostCategory } from '@solus/contracts/uplink'
import type { WebhookUrlMode } from '@solus/contracts/webhooks'

/** The reachability texts of docs/plans/webhooks.md §4. The editor and the table show them as written. */
export const REACHABILITY_TEXT = {
  heldWhileOffline: 'Requests wait in Solus Cloud for up to 24 hours while this host is offline.',
  failWhileOffline: 'Requests fail while this host is offline.',
  failWhileAsleep: 'Requests fail while this computer sleeps. Turn on holding, or use a cloud machine.',
  direct: 'Solus cannot hold requests for this host. Keep it reachable at its public URL.',
  noUrl: 'Link this host to Solus Cloud, or set its public URL.',
} as const

/**
 * What happens to a request while the host is away, in words (plan §4).
 * `holdWhileOffline` is the host's setting; `undefined` means it is not read
 * yet, and then a cloud URL has no text, because a guess would be wrong half the
 * time. A personal computer that does not hold requests gets the sleep text.
 */
export function webhookReachabilityText(
  urlMode: WebhookUrlMode,
  holdWhileOffline: boolean | null | undefined,
  category: HostCategory | undefined,
): string | null {
  if (urlMode === 'none') return REACHABILITY_TEXT.noUrl
  if (urlMode === 'direct') return REACHABILITY_TEXT.direct
  if (holdWhileOffline === undefined) return null
  if (holdWhileOffline === true) return REACHABILITY_TEXT.heldWhileOffline
  return category === 'personal' ? REACHABILITY_TEXT.failWhileAsleep : REACHABILITY_TEXT.failWhileOffline
}

export function urlModeLabel(urlMode: WebhookUrlMode): string {
  switch (urlMode) {
    case 'cloud': return 'Solus Cloud URL'
    case 'direct': return 'Direct URL'
    case 'none': return 'No URL'
  }
}

/** The unlink warning (plan §2.2): null when no webhook of the host uses the cloud URL. */
export function unlinkWebhookWarning(cloudUrlCount: number): string | null {
  if (cloudUrlCount <= 0) return null
  return cloudUrlCount === 1
    ? '1 webhook uses the Solus Cloud URL. Its sender must get the new URL.'
    : `${cloudUrlCount} webhooks use the Solus Cloud URL. Their senders must get the new URL.`
}
