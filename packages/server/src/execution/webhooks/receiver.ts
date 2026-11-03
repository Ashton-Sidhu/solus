import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  WEBHOOK_DELIVERIES_PER_MINUTE,
  WEBHOOK_ID_PATTERN,
  WEBHOOK_TOKEN_PATTERN,
  WEBHOOK_MAX_BODY_BYTES,
  type WebhookAnswerOutcome,
  type WebhookDeliveryOutcome,
  type WebhookVerificationFailure,
} from '@solus/contracts/webhooks'
import { LOCAL_ORGANIZATION_ID } from '../../host/host-category'
import { createLogger } from '../../logger'
import type { FetchLike } from '../../admission/access-tokens'
import { afterDatabaseCommit, getDatabase } from '../../db/database'
import { claimWebhookKey } from '../../data/receipts/operation-receipts'
import { insertDelivery, loadWebhook, type NewDelivery, type WebhookRecord } from '../../data/webhooks/webhook-store'
import { readWebhookSecrets, verificationSecretOf } from '../../data/webhooks/webhook-secrets'
import { readDeliveryProof, type ProvenDelivery } from './delivery-proof'
import { renderKey, requestData, storedRequest, type WebhookRequestData } from './request-data'
import { verifyRequest } from './verification'
import { emitWebhookDelivery } from './webhook-events'

const log = createLogger('webhooks', 'receiver.ts')

/**
 * The receiver (docs/plans/webhooks.md §3.4): the route on the host that accepts
 * a request for a webhook. The checks run in this order:
 *
 * 1. Body over 1 MiB → 413.
 * 2. Unknown webhook or wrong token → 404, the same answer for both.
 * 3. More than 60 deliveries in one minute → 429, before verification, so an
 *    unsigned flood costs no signature check.
 * 4. Verification fails → 401, logged with the step that failed.
 * 5. An unverified organization webhook the policy does not allow → 403; paused
 *    by the owner or an organization admin → 409. After verification, so a
 *    sender without the secret cannot learn that the token is valid.
 * 6. A proven delivery ID seen in the last 25 hours → 202 `duplicate`.
 * 7. A replay key seen in the last 7 days → 202 `duplicate`.
 * 8. Otherwise → 202 with the delivery ID; the actions run after the answer.
 *
 * Every answer carries `x-solus-hook-outcome` (the HTTP layer sets it from `outcome`).
 */

export interface ReceiverRequest {
  method: string
  webhookId: string
  token: string
  headers: Iterable<[string, string]>
  query: Iterable<[string, string]>
  body: Buffer
}

export interface ReceiverAnswer {
  status: 202 | 401 | 403 | 404 | 405 | 409 | 413 | 429
  outcome: WebhookAnswerOutcome
  body: { deliveryId?: string; error?: string }
}

/** A delivery the receiver accepted: what the action runner needs. */
export interface AcceptedDelivery {
  webhook: WebhookRecord
  deliveryId: string
  data: WebhookRequestData
}

export interface WebhookReceiverDeps {
  /** This host's ID in Solus Cloud, for the delivery proof; null while the host is not registered. */
  hostId(): string | null
  /** The forwarder secret from the link answer (plan §2.5); null while the host is not linked. */
  forwarderSecret(): Buffer | null
  /** An organization admin paused this webhook (plan §2.7), as the host's organization facts say. */
  isPausedByAdmin(webhookId: string): boolean
  /** The organization's `allowsUnverifiedWebhooks` policy (plan §3.7). */
  allowsUnverifiedWebhooks(organizationId: string): boolean
  /** Runs the actions of an accepted delivery. Called after the answer; it must not throw. */
  runDelivery(delivery: AcceptedDelivery): Promise<void>
  now?: () => number
  fetchImpl?: FetchLike
}

const ALLOWED_METHODS = new Set(['POST', 'PUT', 'PATCH'])

function answer(status: ReceiverAnswer['status'], outcome: WebhookAnswerOutcome, body: ReceiverAnswer['body'] = {}): ReceiverAnswer {
  return { status, outcome, body }
}

/** Compares two tokens in constant time: their hashes have the same length. */
function tokenMatches(presented: string, stored: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(stored).digest()
  return timingSafeEqual(a, b)
}

/** True when an organization's policy refuses this webhook because it is unverified. */
export function refusedAsUnverified(webhook: Pick<WebhookRecord, 'verification' | 'organizationId'>, allowsUnverified: (organizationId: string) => boolean): boolean {
  return webhook.verification.scheme === 'none' && webhook.organizationId !== LOCAL_ORGANIZATION_ID && !allowsUnverified(webhook.organizationId)
}

export function createWebhookReceiver(deps: WebhookReceiverDeps) {
  // One window for each webhook. Only a known webhook with its token gets one, so a stranger cannot grow the map.
  const windows = new Map<string, { count: number; resetAt: number }>()
  const allow = (webhookId: string, at: number): boolean => {
    const window = windows.get(webhookId)
    if (!window || window.resetAt <= at) {
      windows.set(webhookId, { count: 1, resetAt: at + 60_000 })
      return true
    }
    window.count += 1
    return window.count <= WEBHOOK_DELIVERIES_PER_MINUTE
  }
  const now = deps.now ?? Date.now

  async function logRefused(webhook: WebhookRecord, proven: ProvenDelivery, arrivedAt: number, data: WebhookRequestData, outcome: WebhookDeliveryOutcome, reason: string, failure: WebhookVerificationFailure | null = null): Promise<string> {
    const delivery: NewDelivery = {
      id: randomUUID(),
      webhookId: webhook.id,
      receivedAt: proven.receivedAt,
      arrivedAt,
      source: proven.source,
      outcome,
      reason,
      replayOf: null,
      request: storedRequest(data),
      verificationFailure: failure,
      actions: [],
    }
    await insertDelivery(delivery)
    // A duplicate is logged inside the claim transaction: the event waits for its commit.
    await afterDatabaseCommit(async () => {
      emitWebhookDelivery({ id: delivery.id, webhookId: webhook.id, receivedAt: delivery.receivedAt, arrivedAt, source: delivery.source, outcome, reason, replayOf: null })
      log.info('webhook_delivery_refused', { webhookId: webhook.id, deliveryId: delivery.id, outcome, step: failure?.step ?? null })
    })
    return delivery.id
  }

  async function receive(request: ReceiverRequest): Promise<ReceiverAnswer> {
    const arrivedAt = now()
    if (!ALLOWED_METHODS.has(request.method)) return answer(405, 'method_not_allowed', { error: 'Use POST, PUT, or PATCH.' })
    if (request.body.length > WEBHOOK_MAX_BODY_BYTES) return answer(413, 'too_large', { error: 'The body is larger than 1 MiB.' })

    if (!WEBHOOK_ID_PATTERN.test(request.webhookId) || !WEBHOOK_TOKEN_PATTERN.test(request.token)) return answer(404, 'not_found', { error: 'not found' })
    const webhook = await loadWebhook(request.webhookId)
    const stored = webhook ? readWebhookSecrets(webhook.id) : null
    if (!webhook || !stored || !tokenMatches(request.token, stored.token)) return answer(404, 'not_found', { error: 'not found' })

    if (!allow(webhook.id, arrivedAt)) return answer(429, 'rate_limited', { error: 'Too many deliveries. Try again in a minute.' })

    const data = requestData(request.method, request.headers, request.query, request.body)
    const proven = readDeliveryProof({ headers: data.headers, hostId: deps.hostId(), webhookId: webhook.id, arrivedAt, forwarderSecret: deps.forwarderSecret() })
    const verified = await verifyRequest(webhook.verification, data, { secret: verificationSecretOf(stored), now: proven.receivedAt, fetchImpl: deps.fetchImpl })
    if (!verified.ok) {
      await logRefused(webhook, proven, arrivedAt, data, 'unverified', 'Verification failed.', verified.failure)
      return answer(401, 'unverified', { error: 'Verification failed.' })
    }

    if (refusedAsUnverified(webhook, deps.allowsUnverifiedWebhooks)) {
      await logRefused(webhook, proven, arrivedAt, data, 'not_allowed', 'The organization does not allow unverified webhooks.')
      return answer(403, 'not_allowed', { error: 'The organization does not allow unverified webhooks.' })
    }
    const pausedByAdmin = deps.isPausedByAdmin(webhook.id)
    if (!webhook.enabled || pausedByAdmin) {
      await logRefused(webhook, proven, arrivedAt, data, 'paused', pausedByAdmin ? 'Paused by an organization admin.' : 'Paused.')
      return answer(409, 'paused', { error: 'This webhook is paused.' })
    }

    const replayKey = webhook.replayKey ? renderKey(webhook.replayKey, data) : null
    // The key claims and the delivery row commit together: a failed insert
    // releases the claims, and a duplicate answer keeps the IDs it consumed.
    // A duplicate is a decision, not an error, so the transaction commits.
    const decision = await getDatabase().transaction(async (tx) => {
      if (proven.deliveryId && !(await claimWebhookKey(tx, webhook.id, 'delivery', proven.deliveryId, arrivedAt))) {
        return { outcome: 'duplicate' as const, deliveryId: await logRefused(webhook, proven, arrivedAt, data, 'duplicate', 'This delivery ID came before.') }
      }
      if (replayKey !== null && !(await claimWebhookKey(tx, webhook.id, 'replay', replayKey, arrivedAt))) {
        return { outcome: 'duplicate' as const, deliveryId: await logRefused(webhook, proven, arrivedAt, data, 'duplicate', 'This replay key came before.') }
      }

      const deliveryId = randomUUID()
      await insertDelivery({
        id: deliveryId,
        webhookId: webhook.id,
        receivedAt: proven.receivedAt,
        arrivedAt,
        source: proven.source,
        outcome: 'pending',
        reason: null,
        replayOf: null,
        request: storedRequest(data),
        verificationFailure: null,
        actions: [],
      }, tx)
      // The event and the actions wait for the outermost commit: a rolled-back delivery runs nothing.
      await afterDatabaseCommit(async () => {
        emitWebhookDelivery({ id: deliveryId, webhookId: webhook.id, receivedAt: proven.receivedAt, arrivedAt, source: proven.source, outcome: 'pending', reason: null, replayOf: null })
        log.info('webhook_delivery_accepted', { webhookId: webhook.id, deliveryId, source: proven.source })
        // The sender does not wait for an agent.
        setImmediate(() => void deps.runDelivery({ webhook, deliveryId, data }))
      })
      return { outcome: 'accepted' as const, deliveryId }
    })
    return answer(202, decision.outcome, { deliveryId: decision.deliveryId })
  }

  return { receive }
}

export type WebhookReceiver = ReturnType<typeof createWebhookReceiver>
