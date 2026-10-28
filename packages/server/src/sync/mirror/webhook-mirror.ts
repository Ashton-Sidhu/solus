import { basename } from 'node:path'
import { parseUserKey } from '@solus/contracts/user'
import type { WebhookAction, WebhookDelivery, WebhookUrlMode } from '@solus/contracts/webhooks'
import type { WebhookAdminDeliverySummary, WebhookAdminMirrorPayload, WebhookAdminRecord } from '@solus/contracts/webhook-admin'
import { LOCAL_ORGANIZATION_ID } from '../../host/host-category'
import { hostUserId, isHostUserKey } from '../../host/host-user'
import { createLogger } from '../../logger'
import { appendDelivery, deliveryActorOf } from '../delivery-queue'

const log = createLogger('webhooks', 'webhook-mirror.ts')

/**
 * The organization admin view of webhooks (docs/plans/webhooks.md §2.7): a host
 * queues the metadata of each organization webhook and a summary of each delivery
 * for the organization's Solus API, which gives them to Solus Cloud. Never the body,
 * the headers, the token, the secret, or a rendered prompt. A Local webhook, or a
 * host that is not registered, sends nothing.
 */

/** The facts of a webhook the mirror reads: a `Webhook` view has them all. */
export interface MirroredWebhook {
  id: string
  organizationId: string
  ownerKey: string
  name: string
  project: string | null
  urlMode: WebhookUrlMode
  enabled: boolean
  actions: Pick<WebhookAction, 'type'>[]
  updatedAt: number
}

/** The account that owns a webhook; null for a person with no account, whom the admin view cannot name. */
function ownerAccountId(ownerKey: string): string | null {
  const id = isHostUserKey(ownerKey) ? hostUserId() : parseUserKey(ownerKey)
  return id?.kind === 'account' ? id.accountId : null
}

function queue(webhook: MirroredWebhook, key: string, payload: WebhookAdminMirrorPayload, registered: boolean): void {
  if (!registered || webhook.organizationId === LOCAL_ORGANIZATION_ID) return
  appendDelivery({ organizationId: webhook.organizationId, actorUserId: deliveryActorOf(webhook.ownerKey) }, 'webhooks', [{ key, payload }])
}

/** Queues a webhook's metadata after a save, or its removal after a delete. */
export function mirrorWebhook(webhook: MirroredWebhook, options: { deleted?: boolean; registered: boolean; now?: number }): void {
  const ownerUserId = ownerAccountId(webhook.ownerKey)
  if (!ownerUserId) {
    if (webhook.organizationId !== LOCAL_ORGANIZATION_ID) log.warn('webhook_mirror_owner_unknown', { webhookId: webhook.id })
    return
  }
  const record: WebhookAdminRecord = {
    webhookId: webhook.id,
    name: webhook.name.slice(0, 200),
    ownerUserId,
    projectName: webhook.project ? basename(webhook.project).slice(0, 200) : null,
    urlMode: webhook.urlMode,
    state: webhook.enabled ? 'active' : 'paused',
    actionTypes: webhook.actions.map((action) => action.type).slice(0, 10),
    // A delete is newer than the last save, so Solus Cloud does not keep the older version.
    changedAt: options.deleted ? Math.max(options.now ?? Date.now(), webhook.updatedAt) : webhook.updatedAt,
  }
  if (options.deleted) record.deleted = true
  queue(webhook, `webhook:${webhook.id}`, { webhooks: [record] }, options.registered)
}

/** Queues the summary of one finished delivery: its time, outcome, and the status of each action. */
export function mirrorWebhookDelivery(webhook: MirroredWebhook, delivery: WebhookDelivery, options: { registered: boolean }): void {
  const summary: WebhookAdminDeliverySummary = {
    webhookId: webhook.id,
    deliveryId: delivery.id,
    receivedAt: delivery.receivedAt,
    outcome: delivery.outcome,
    actionStatuses: delivery.actions.map((action) => action.status).slice(0, 10),
  }
  queue(webhook, `delivery:${delivery.id}`, { deliveries: [summary] }, options.registered)
}
