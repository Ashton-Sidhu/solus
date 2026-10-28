import type {
  WebhookActionStatus,
  WebhookDeliveryOutcome,
  WebhookDeliverySource,
  WebhookFilter,
  WebhookVerificationFailure,
} from '@solus/contracts/webhooks'
import { isFailingOutcome, type WebhookOutcomeFilter } from './webhooks-view'
import { filterOpLabel } from './webhook-draft'

/** The deliveries log in words (docs/plans/webhooks.md §2.3, §3.3, §3.7). */

/** Whether a delivery passes the list's outcome filter; an empty filter passes all. */
export function deliveryMatches(outcome: WebhookDeliveryOutcome, filter: '' | WebhookOutcomeFilter): boolean {
  if (filter === '') return true
  if (filter === 'failing') return isFailingOutcome(outcome)
  return outcome === filter
}

/** The forwarder's lost count (plan §2.3). "Not verified": the forwarder does not check tokens. */
export function lostRequestsText(count: number): string {
  return count === 1
    ? '1 request was lost while this host was offline (not verified).'
    : `${count} requests were lost while this host was offline (not verified).`
}

export function sourceLabel(source: WebhookDeliverySource): string {
  switch (source) {
    case 'direct': return 'Direct'
    case 'forwarded': return 'Through Solus Cloud'
    case 'held': return 'Held while offline'
  }
}

export function actionStatusLabel(status: WebhookActionStatus): string {
  switch (status) {
    case 'skipped': return 'Skipped'
    case 'matched': return 'Would run'
    case 'started': return 'Started'
    case 'queued': return 'Queued'
    case 'busy': return 'Busy'
    case 'failed': return 'Failed'
  }
}

/** The step that failed, never a secret or a computed signature. */
export function verificationFailureText(failure: WebhookVerificationFailure): string {
  const detail = failure.detail ? ` (${failure.detail})` : ''
  switch (failure.step) {
    case 'value_missing': return `Verification failed: a value is missing${detail}.`
    case 'timestamp_outside_tolerance': return 'Verification failed: the timestamp is too old or too new.'
    case 'signature_mismatch': return 'Verification failed: the signature does not match.'
    case 'jwt_invalid': return `Verification failed: the token is not valid${detail}.`
    case 'keys_unavailable': return 'Verification failed: Solus could not get the signing keys.'
    case 'secret_missing': return 'Verification failed: the host has no secret for this webhook.'
  }
}

/** "headers.x-github-event equals pull_request". */
export function filterText(filter: WebhookFilter): string {
  if (filter.op === 'exists') return `${filter.path} exists`
  if (filter.op === 'in') return `${filter.path} ${filterOpLabel('in')} ${filter.values.join(', ')}`
  return `${filter.path} ${filterOpLabel(filter.op)} ${filter.value}`
}
