import { createHmac, randomUUID } from 'node:crypto'
import { WEBHOOK_TEST_HEADER, type WebhookDeliverySummary, type WebhookValueSource, type WebhookVerification } from '@solus/contracts/webhooks'
import { readDelivery, type WebhookRecord } from '../../data/webhooks/webhook-store'
import { readWebhookSecrets, verificationSecretOf } from '../../data/webhooks/webhook-secrets'
import { summaryOf } from './action-runner'
import type { WebhookReceiver } from './receiver'
import { requestData } from './request-data'
import { renderSignedText } from './verification'

/**
 * Send test (docs/plans/apps.md §9.2): the host signs a small request with the
 * webhook's stored secret, as the sender does, and gives it to its own
 * receiver. The test takes the same path as a real delivery: the rate limit,
 * verification, the pause and policy checks, the log, and the actions. A
 * scheme whose key the sender holds (a public key, a JWT) cannot be signed here.
 */

export class WebhookTestError extends Error {}

export interface TestRequest {
  headers: [string, string][]
  body: Buffer
}

/** Puts a value where a source reads it: a header, one `key=value` part of a header, or a bearer token. */
function place(headers: Map<string, string>, source: WebhookValueSource, value: string): void {
  if (source.kind === 'bearer') {
    headers.set('authorization', `Bearer ${value}`)
    return
  }
  const name = source.name.toLowerCase()
  if (source.kind === 'header') {
    headers.set(name, value)
    return
  }
  const part = `${source.key}=${value}`
  const existing = headers.get(name)
  headers.set(name, existing ? `${existing}${source.separator}${part}` : part)
}

function needsSecret(secret: Buffer | null): Buffer {
  if (!secret) throw new WebhookTestError('This webhook has no signing secret on the host, so Solus cannot sign a test.')
  return secret
}

/** The test request of a webhook, signed for its verification scheme. */
export function testRequest(webhook: Pick<WebhookRecord, 'name' | 'verification'>, secret: Buffer | null, now: number): TestRequest {
  const body = Buffer.from(JSON.stringify({ test: true, webhook: webhook.name, sentAt: new Date(now).toISOString() }), 'utf8')
  const headers = new Map<string, string>([['content-type', 'application/json'], ['user-agent', 'Solus-Webhook-Test'], [WEBHOOK_TEST_HEADER, '1']])
  const seconds = String(Math.floor(now / 1000))
  const verification: WebhookVerification = webhook.verification
  switch (verification.scheme) {
    case 'none':
      break
    case 'token':
      place(headers, verification.source, needsSecret(secret).toString('utf8'))
      break
    case 'standard_webhooks': {
      const id = `msg_test_${randomUUID()}`
      const signature = createHmac('sha256', needsSecret(secret)).update(Buffer.concat([Buffer.from(`${id}.${seconds}.`, 'utf8'), body])).digest('base64')
      headers.set('webhook-id', id)
      headers.set('webhook-timestamp', seconds)
      headers.set('webhook-signature', `v1,${signature}`)
      break
    }
    case 'hmac': {
      const key = needsSecret(secret)
      if (verification.timestamp) place(headers, verification.timestamp.source, seconds)
      // The signed text can name a header that the timestamp filled (`{{headers.stripe-signature|t}}`).
      const signed = renderSignedText(verification.signedText, requestData('POST', headers, [], body))
      if (!signed) throw new WebhookTestError('The signed text of this webhook names a value that only the sender has, so Solus cannot sign a test.')
      const digest = createHmac(verification.algorithm, key).update(signed).digest(verification.signature.format.encoding)
      place(headers, verification.signature.source, `${verification.signature.format.prefix ?? ''}${digest}`)
      break
    }
    case 'public_key':
    case 'jwt':
      throw new WebhookTestError('The sender holds the private key of this webhook, so Solus cannot sign a test. Send one from the sender.')
  }
  return { headers: [...headers], body }
}

/** Signs a test request and gives it to the receiver. Answers the delivery the log keeps; throws why the receiver refused it. */
export async function sendTestDelivery(receiver: WebhookReceiver, webhook: Pick<WebhookRecord, 'id' | 'name' | 'verification'>, now = Date.now()): Promise<WebhookDeliverySummary> {
  const secrets = readWebhookSecrets(webhook.id)
  if (!secrets) throw new WebhookTestError('That webhook does not exist.')
  const request = testRequest(webhook, verificationSecretOf(secrets), now)
  const answer = await receiver.receive({ method: 'POST', webhookId: webhook.id, token: secrets.token, headers: request.headers, query: [], body: request.body })
  const deliveryId = answer.body.deliveryId
  if (!deliveryId) throw new WebhookTestError(answer.body.error ?? 'The receiver did not take the test.')
  const delivery = await readDelivery(deliveryId)
  if (!delivery) throw new WebhookTestError('The test was not recorded.')
  return summaryOf(delivery)
}
