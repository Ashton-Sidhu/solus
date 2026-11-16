import {
  WEBHOOK_TEST_HEADER,
  type WebhookActionResult,
  type WebhookDelivery,
  type WebhookDeliveryOutcome,
  type WebhookDeliverySummary,
  type WebhookValueSource,
  type WebhookVerification,
} from '@solus/contracts/webhooks'
import { sourceLabel, verificationFailureText } from '../../../webhooks/lib/webhook-deliveries'

/**
 * The Webhooks section (docs/plans/apps.md §9.2): the deliveries of one app
 * webhook in words. A delivery is what the receiver kept: its request with
 * credentials redacted, how the receiver answered, and how the mutation ended.
 */

const WEEK_MS = 7 * 24 * 60 * 60_000

/** The HTTP status the receiver answered with (docs/plans/webhooks.md §3.4). */
export function answerStatus(outcome: WebhookDeliveryOutcome): number {
  switch (outcome) {
    case 'unverified': return 401
    case 'not_allowed': return 403
    case 'paused': return 409
    default: return 202
  }
}

/** The receiver refused the request: nothing ran. */
export function isRefused(outcome: WebhookDeliveryOutcome): boolean {
  return answerStatus(outcome) >= 400
}

/** The delivery's mutation did not end well, or the receiver refused it. */
export function isFailedDelivery(outcome: WebhookDeliveryOutcome): boolean {
  return isRefused(outcome) || outcome === 'failed' || outcome === 'partial'
}

/** One line for a delivery in the list: what happened to it. `run` is the mutation the webhook runs. */
export function deliveryTitle(delivery: Pick<WebhookDeliverySummary, 'outcome' | 'replayOf'>, run: string): string {
  const replay = delivery.replayOf ? 'Replay: ' : ''
  switch (delivery.outcome) {
    case 'pending': return `${replay}Running ${run}`
    case 'ran': return `${replay}Ran ${run}`
    case 'partial':
    case 'failed': return `${replay}${run} failed`
    case 'filtered': return `${replay}Nothing ran`
    case 'duplicate': return 'Duplicate request'
    case 'unverified': return 'Request not verified'
    case 'not_allowed': return 'Request not allowed'
    case 'paused': return 'Webhook paused'
  }
}

/** The second line: why nothing ran, or where the request came from. */
export function deliverySubtitle(delivery: Pick<WebhookDeliverySummary, 'reason' | 'source' | 'outcome'>): string {
  const where = sourceLabel(delivery.source)
  if (isRefused(delivery.outcome)) return `${where} · refused`
  return delivery.reason ? `${where} · ${delivery.reason}` : where
}

/** "14:31" today, "Sat" in the last week, "Nov 3" before. */
export function deliveryTime(at: number, now = Date.now()): string {
  const date = new Date(at)
  if (date.toDateString() === new Date(now).toDateString()) return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (now - at < 6 * 24 * 60 * 60_000) return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "Runs recordRelease · 212 this week, 1 refused". `list` is the newest page; a full page that the week fills reads "200+". */
export function webhookSummaryText(run: string, list: readonly WebhookDeliverySummary[] | undefined, page: number, now = Date.now()): string {
  if (!list) return `Runs ${run}`
  const week = list.filter((delivery) => now - delivery.arrivedAt < WEEK_MS)
  const isCut = list.length >= page && week.length === list.length
  const refused = week.filter((delivery) => isRefused(delivery.outcome)).length
  const count = `${week.length}${isCut ? '+' : ''} this week`
  return `Runs ${run} · ${refused > 0 ? `${count}, ${refused} refused` : count}`
}

/** "whsec_••••3f9a": enough to tell two secrets apart, not enough to use one. */
export function maskedSecret(secret: string): string {
  const prefix = secret.startsWith('whsec_') ? 'whsec_' : ''
  return `${prefix}••••${secret.slice(-4)}`
}

/** A test that Send test made: the host marks its request. */
export function isTestDelivery(delivery: Pick<WebhookDelivery, 'request'>): boolean {
  return delivery.request.headers.some(([name]) => name.toLowerCase() === WEBHOOK_TEST_HEADER)
}

/** The header a value source reads, in lower case. */
function headerOf(source: WebhookValueSource): string {
  return source.kind === 'bearer' ? 'authorization' : source.name.toLowerCase()
}

/** The headers that carry the proof of a request, by the webhook's verification. */
export function proofHeaders(verification: WebhookVerification | undefined): string[] {
  if (!verification) return []
  switch (verification.scheme) {
    case 'none': return []
    case 'standard_webhooks': return ['webhook-signature']
    case 'token':
    case 'jwt': return [headerOf(verification.source)]
    case 'hmac':
    case 'public_key': return [headerOf(verification.signature.source)]
  }
}

export interface HeaderRow {
  name: string
  value: string
  /** For the header that carries the proof: whether it passed verification. */
  check: 'valid' | 'invalid' | null
}

/** The stored headers, with the check of the proof header. The receiver keeps a credential as `[redacted]`. */
export function headerRows(delivery: Pick<WebhookDelivery, 'request' | 'outcome' | 'verificationFailure'>, verification: WebhookVerification | undefined): HeaderRow[] {
  const proof = new Set(proofHeaders(verification))
  const isInvalid = delivery.outcome === 'unverified' || delivery.verificationFailure !== null
  return delivery.request.headers.map(([name, value]) => ({
    name,
    value,
    check: proof.has(name.toLowerCase()) ? (isInvalid ? 'invalid' : 'valid') : null,
  }))
}

/** A body or an answer as a code block shows it. */
export interface CodeView {
  text: string
  /** `json` for JSON; undefined for plain text. */
  lang: string | undefined
}

/** The receiver's answer: its HTTP status and its JSON body. */
export interface AnswerView {
  status: number
  body: string
}

/** The body as the code block shows it: JSON set out, else the text. */
export function bodyView(request: WebhookDelivery['request']): CodeView {
  if (request.bodyIsBase64) return { text: `The body is not text (${Math.round(request.body.length * 0.75)} bytes).`, lang: undefined }
  if (!request.body) return { text: 'The body is empty.', lang: undefined }
  try {
    return { text: JSON.stringify(JSON.parse(request.body), null, 2), lang: 'json' }
  } catch {
    return { text: request.body, lang: undefined }
  }
}

/** The receiver's answer as the sender read it. */
export function answerText(delivery: Pick<WebhookDelivery, 'id' | 'outcome' | 'reason' | 'verificationFailure'>): AnswerView {
  const status = answerStatus(delivery.outcome)
  if (status >= 400) {
    const error = delivery.verificationFailure ? 'Verification failed.' : delivery.reason ?? 'Refused.'
    return { status, body: JSON.stringify({ error }, null, 2) }
  }
  return { status, body: JSON.stringify({ deliveryId: delivery.id }, null, 2) }
}

/** Why the receiver refused, in the words of the verification step that failed. */
export function refusalText(delivery: Pick<WebhookDelivery, 'reason' | 'verificationFailure'>): string | null {
  return delivery.verificationFailure ? verificationFailureText(delivery.verificationFailure) : delivery.reason
}

/** How the mutation of a delivery ended: "Started recordRelease, which answered in 88ms." */
export function callText(result: WebhookActionResult | undefined, run: string): string {
  if (!result) return 'Nothing ran: the receiver refused the request.'
  const time = result.durationMs === undefined ? '' : `, which answered in ${result.durationMs}ms`
  switch (result.status) {
    case 'started':
    case 'queued': return `Started ${run}${time}.`
    case 'failed':
    case 'busy': return `${run} failed${time}: ${result.error ?? 'no reason given'}.`
    case 'matched': return `${run} would run.`
    case 'skipped': return result.error ? `${run} did not run: ${result.error}` : `${run} did not run.`
  }
}
