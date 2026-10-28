import type { WebhookChangedEvent, WebhookDeliverySummary } from '@solus/contracts/webhooks'
import { createLogger } from '../../logger'

const log = createLogger('webhooks', 'webhook-events.ts')

/**
 * The webhook events a server broadcasts (docs/plans/webhooks.md §5):
 * `webhook.changed` and `webhook.delivery`. A delivery event is a short summary,
 * never the body. A delivery comes with no client in the loop, so push is the
 * only way a client learns about it without reading again.
 */

type Listener<T> = (event: T) => void

const changedListeners = new Set<Listener<WebhookChangedEvent>>()
const deliveryListeners = new Set<Listener<WebhookDeliverySummary>>()

function notify<T>(listeners: Set<Listener<T>>, event: T, name: string): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      log.error('webhook_listener_failed', { event: name, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

export function onWebhookChanged(listener: Listener<WebhookChangedEvent>): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

export function emitWebhookChanged(event: WebhookChangedEvent): void {
  notify(changedListeners, event, 'webhook.changed')
}

export function onWebhookDelivery(listener: Listener<WebhookDeliverySummary>): () => void {
  deliveryListeners.add(listener)
  return () => deliveryListeners.delete(listener)
}

export function emitWebhookDelivery(delivery: WebhookDeliverySummary): void {
  notify(deliveryListeners, delivery, 'webhook.delivery')
}
