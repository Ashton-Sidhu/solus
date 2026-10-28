import type {
  HostWebhookSettings,
  Webhook,
  WebhookActionStatus,
  WebhookActionType,
  WebhookDeliveryOutcome,
  WebhookDeliverySource,
  WebhookDeliverySummary,
  WebhookUrlMode,
  WebhookVerificationFailure,
  WebhookWithUrl,
  WebhookLastDelivery,
} from '@solus/contracts/webhooks'
import { relativeTime } from '../../lib/time'

/**
 * The words and the order of the phone's Webhooks screens
 * (docs/plans/webhooks.md §4). Version 1 shows the list, the deliveries,
 * pause and resume, replay, Copy, and the two host settings.
 */

export type WebhookListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; webhooks: Webhook[] }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

export type HostWebhookSettingsState =
  | { kind: 'loading' }
  | { kind: 'loaded'; settings: HostWebhookSettings }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

export const UNSUPPORTED_NOTE = 'This host does not support webhooks. Update Solus on it.'
/** The text that marks every unverified webhook (plan §3.7). */
export const UNVERIFIED_TEXT = 'No verification. Anyone with this URL can start agent work.'
export const PAUSED_BY_ADMIN_TEXT = 'Paused by organization admin'
export const URL_CHANGED_TEXT = 'URL changed since you copied it'

/**
 * What the host says about reaching a webhook while it is offline (plan §4).
 * Null for a cloud URL while the host settings are not read: the hold state
 * is not known, and a guess would be a false promise.
 */
export function reachabilityText(urlMode: WebhookUrlMode, settings: HostWebhookSettings | null, isPersonalHost: boolean): string | null {
  if (urlMode === 'none') return 'Link this host to Solus Cloud, or set its public URL.'
  if (urlMode === 'direct') return 'Solus cannot hold requests for this host. Keep it reachable at its public URL.'
  if (!settings) return null
  if (settings.holdWhileOffline !== false) return 'Requests wait in Solus Cloud for up to 24 hours while this host is offline.'
  return isPersonalHost
    ? 'Requests fail while this computer sleeps. Turn on holding, or use a cloud machine.'
    : 'Requests fail while this host is offline.'
}

/** The URL mode the host gives its webhooks now (plan §2.2), for the host settings. */
export function hostUrlMode(settings: HostWebhookSettings): WebhookUrlMode {
  if (settings.linked) return 'cloud'
  return settings.publicUrl ? 'direct' : 'none'
}

export function urlModeLabel(mode: WebhookUrlMode): string {
  switch (mode) {
    case 'cloud': return 'Solus Cloud URL'
    case 'direct': return 'Direct URL'
    case 'none': return 'No URL'
  }
}

export function webhookStateLabel(webhook: Pick<Webhook, 'enabled' | 'pausedByAdmin'>): string {
  if (webhook.pausedByAdmin) return PAUSED_BY_ADMIN_TEXT
  return webhook.enabled ? 'Active' : 'Paused'
}

/** The control a person has: only an organization admin resumes an admin pause (plan §2.7). */
export function pauseControl(webhook: Pick<Webhook, 'enabled' | 'pausedByAdmin'>): 'pause' | 'resume' | 'none' {
  if (webhook.pausedByAdmin) return 'none'
  return webhook.enabled ? 'pause' : 'resume'
}

/** The reason of an unverified webhook, or null when it has verification. */
export function unverifiedReason(webhook: Pick<Webhook, 'verification'>): string | null {
  return webhook.verification.scheme === 'none' ? webhook.verification.reason : null
}

export function outcomeLabel(outcome: WebhookDeliveryOutcome): string {
  switch (outcome) {
    case 'pending': return 'Running'
    case 'ran': return 'Ran'
    case 'partial': return 'Partly failed'
    case 'failed': return 'Failed'
    case 'filtered': return 'No action matched'
    case 'duplicate': return 'Duplicate'
    case 'unverified': return 'Not verified'
    case 'not_allowed': return 'Not allowed'
    case 'paused': return 'Paused'
  }
}

/** True for an outcome that needs attention: work did not start as the sender asked. */
export function isFailingOutcome(outcome: WebhookDeliveryOutcome): boolean {
  return outcome === 'partial' || outcome === 'failed' || outcome === 'unverified' || outcome === 'not_allowed'
}

export function actionStatusLabel(status: WebhookActionStatus): string {
  switch (status) {
    case 'skipped': return 'Skipped'
    case 'matched': return 'Matched'
    case 'started': return 'Started'
    case 'queued': return 'Queued'
    case 'busy': return 'Busy'
    case 'failed': return 'Failed'
  }
}

export function actionTypeLabel(type: WebhookActionType): string {
  switch (type) {
    case 'start_session': return 'Start a session'
    case 'send_to_session': return 'Send to a session'
    case 'run_automation': return 'Run an automation'
  }
}

export function sourceLabel(source: WebhookDeliverySource): string {
  switch (source) {
    case 'direct': return 'Direct'
    case 'forwarded': return 'Through Solus Cloud'
    case 'held': return 'Held in Solus Cloud'
  }
}

/** The verification step that failed (plan §3.7 Debugging), never a secret. */
export function verificationFailureText(failure: WebhookVerificationFailure): string {
  const detail = failure.detail ? ` (${failure.detail})` : ''
  switch (failure.step) {
    case 'value_missing': return `Verification failed: a value is missing${detail}.`
    case 'timestamp_outside_tolerance': return `Verification failed: the timestamp is too old or too new${detail}.`
    case 'signature_mismatch': return `Verification failed: the signature does not match${detail}.`
    case 'jwt_invalid': return `Verification failed: the token is not valid${detail}.`
    case 'keys_unavailable': return `Verification failed: the sender's keys could not be read${detail}.`
    case 'secret_missing': return `Verification failed: this host has no secret for the webhook${detail}.`
  }
}

/** The lost-request line of the deliveries list (plan §2.3), or null when none was lost. */
export function lostText(count: number): string | null {
  if (count <= 0) return null
  return count === 1
    ? '1 request was lost while this host was offline (not verified).'
    : `${count} requests were lost while this host was offline (not verified).`
}

/** The last delivery of the list row: its outcome and how long ago. */
export function lastDeliveryText(last: WebhookLastDelivery | null, now: number): string {
  if (!last) return 'No deliveries yet'
  const age = relativeTime(new Date(last.at).toISOString(), now)
  return `Last delivery: ${outcomeLabel(last.outcome)}, ${age === '<1m' ? 'now' : `${age} ago`}`
}

export function deliveries24hText(count: number): string {
  if (count === 0) return 'No deliveries in 24 hours'
  return count === 1 ? '1 delivery in 24 hours' : `${count} deliveries in 24 hours`
}

/** The last part of a project path, as the list names the project. */
export function projectName(project: string | null): string | null {
  if (!project) return null
  const parts = project.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? project
}

/** The list in name order; the same names keep a stable order by id. */
export function sortWebhooks(webhooks: readonly Webhook[]): Webhook[] {
  return [...webhooks].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** The list with `webhook` added or replaced, in name order. */
export function withWebhook(webhooks: readonly Webhook[], webhook: Webhook): Webhook[] {
  return sortWebhooks([...webhooks.filter((entry) => entry.id !== webhook.id), webhook])
}

export function withoutWebhook(webhooks: readonly Webhook[], webhookId: string): Webhook[] {
  return webhooks.filter((entry) => entry.id !== webhookId)
}

/** Deliveries newest first, as the host gives them: by arrival, then by id. */
export function sortDeliveries(deliveries: readonly WebhookDeliverySummary[]): WebhookDeliverySummary[] {
  return [...deliveries].sort((a, b) => b.arrivedAt - a.arrivedAt || b.id.localeCompare(a.id))
}

/** The list with one delivery added or replaced, newest first. A later summary of the same delivery wins. */
export function withDelivery(deliveries: readonly WebhookDeliverySummary[], delivery: WebhookDeliverySummary): WebhookDeliverySummary[] {
  return sortDeliveries([...deliveries.filter((entry) => entry.id !== delivery.id), delivery])
}

/** Adds an older page below the deliveries shown; a delivery already shown is not repeated. */
export function appendDeliveries(deliveries: readonly WebhookDeliverySummary[], page: readonly WebhookDeliverySummary[]): WebhookDeliverySummary[] {
  const shown = new Set(deliveries.map((entry) => entry.id))
  return sortDeliveries([...deliveries, ...page.filter((entry) => !shown.has(entry.id))])
}

/**
 * What Copy can put on the clipboard from the owner's read. Only the owner
 * gets the URL (plan §5); a host without a URL gives only the path.
 */
export type CopyTarget =
  | { kind: 'url'; url: string }
  | { kind: 'no_url' }
  | { kind: 'not_owner' }
  | { kind: 'missing' }

export function copyTarget(read: Webhook | WebhookWithUrl | null): CopyTarget {
  if (!read) return { kind: 'missing' }
  if (!('url' in read)) return { kind: 'not_owner' }
  return read.url.url ? { kind: 'url', url: read.url.url } : { kind: 'no_url' }
}

/** The host public URL as typed: empty clears it; otherwise an http or https URL. */
export function publicUrlPatch(text: string): { ok: true; publicUrl: string | null } | { ok: false; message: string } {
  const value = text.trim()
  if (value === '') return { ok: true, publicUrl: null }
  if (!/^https?:\/\/[^\s/]+/i.test(value)) return { ok: false, message: 'Enter an http or https URL.' }
  return { ok: true, publicUrl: value.replace(/\/+$/, '') }
}
