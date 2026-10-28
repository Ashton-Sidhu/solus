import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_PROOF_HEADER,
  WEBHOOK_RECEIVED_AT_HEADER,
  type WebhookDeliverySource,
} from '@solus/contracts/webhooks'

/**
 * The delivery proof (docs/plans/webhooks.md §2.5). The forwarder signs its
 * delivery ID and receive time with the per-host forwarder secret. The host
 * trusts them only with a valid proof; without one the request is direct, its
 * receive time is the arrival time, and its delivery ID is ignored.
 */

/** A forwarded request older than this at arrival waited in the inbox. */
const HELD_AFTER_MS = 60_000

export interface ProvenDelivery {
  /** The forwarder's delivery ID; null for a direct request. */
  deliveryId: string | null
  /** The proven receive time, clamped to the arrival time; the arrival time for a direct request. */
  receivedAt: number
  source: WebhookDeliverySource
}

export interface ProofInput {
  headers: Map<string, string>
  hostId: string | null
  webhookId: string
  arrivedAt: number
  forwarderSecret: Buffer | null
}

/** The proof the forwarder sends: lowercase hex HMAC-SHA256 of `hostId.webhookId.deliveryId.receivedAt`. */
export function deliveryProof(secret: Buffer, hostId: string, webhookId: string, deliveryId: string, receivedAt: string): string {
  return createHmac('sha256', secret).update(`${hostId}.${webhookId}.${deliveryId}.${receivedAt}`).digest('hex')
}

export function readDeliveryProof(input: ProofInput): ProvenDelivery {
  const direct: ProvenDelivery = { deliveryId: null, receivedAt: input.arrivedAt, source: 'direct' }
  const deliveryId = input.headers.get(WEBHOOK_DELIVERY_ID_HEADER)
  const receivedAtText = input.headers.get(WEBHOOK_RECEIVED_AT_HEADER)
  const proof = input.headers.get(WEBHOOK_PROOF_HEADER)
  if (!deliveryId || !receivedAtText || !proof || !input.forwarderSecret || !input.hostId) return direct
  if (deliveryId.length > 200 || !/^\d{1,16}$/.test(receivedAtText) || !/^[0-9a-f]{64}$/i.test(proof)) return direct
  const expected = Buffer.from(deliveryProof(input.forwarderSecret, input.hostId, input.webhookId, deliveryId, receivedAtText), 'hex')
  if (!timingSafeEqual(expected, Buffer.from(proof, 'hex'))) return direct
  // A forwarder clock that runs ahead must not fail every timestamp check.
  const receivedAt = Math.min(Number(receivedAtText), input.arrivedAt)
  return { deliveryId, receivedAt, source: input.arrivedAt - receivedAt > HELD_AFTER_MS ? 'held' : 'forwarded' }
}
