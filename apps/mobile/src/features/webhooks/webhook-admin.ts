import type { WebhookAdminEntry, WebhookAdminError, WebhookAdminOutcome, WebhookAdminRef } from '@solus/contracts/webhook-admin'
import type { WebhookDeliveryOutcome } from '@solus/contracts/webhooks'
import type { RowLine } from './webhook-rows'
import { deliveries24hText, outcomeLabel, PAUSED_BY_ADMIN_TEXT, projectName } from './webhooks'
import { relativeTime } from '../../lib/time'

/**
 * The words and the rows of the Organization view of the Webhooks screen
 * (docs/plans/webhooks.md §2.7, §4): the organization webhooks of all members,
 * as the organization's Solus API gives them, with Pause and Resume for an
 * organization admin. An error never shows as an empty list.
 */

export type OrganizationWebhooksState =
  | { kind: 'loading' }
  | { kind: 'loaded'; webhooks: WebhookAdminEntry[] }
  /** The Solus API refused the read: the text says why. */
  | { kind: 'refused'; message: string }
  /** The read did not get an answer: no connection, or an older service. */
  | { kind: 'failed' }

export const ADMIN_FAILED_TEXT = 'The Solus API did not answer. Try again.'
export const ADMIN_EMPTY_TEXT = 'No organization webhooks yet.'

export function adminRefusalText(error: WebhookAdminError): string {
  switch (error) {
    case 'not_organization_admin': return 'Only an organization admin can see this view.'
    case 'host_not_of_organization': return 'That host does not deliver to this organization.'
  }
}

/** The screen state from one answer of `webhookAdminList`, in name order. */
export function organizationWebhooksState(outcome: WebhookAdminOutcome<{ webhooks: WebhookAdminEntry[] }>): OrganizationWebhooksState {
  if (!outcome.ok) return { kind: 'refused', message: adminRefusalText(outcome.error) }
  return { kind: 'loaded', webhooks: sortAdminEntries(outcome.value.webhooks) }
}

/** Name order; the same names keep a stable order by host, then by id. */
export function sortAdminEntries(entries: readonly WebhookAdminEntry[]): WebhookAdminEntry[] {
  return [...entries].sort((a, b) =>
    a.name.localeCompare(b.name) || a.hostId.localeCompare(b.hostId) || a.webhookId.localeCompare(b.webhookId))
}

/** An admin pause comes first: only an admin resumes it (plan §2.7). */
export function adminStateLabel(entry: Pick<WebhookAdminEntry, 'adminPause' | 'state'>): string {
  if (entry.adminPause) return PAUSED_BY_ADMIN_TEXT
  return entry.state === 'paused' ? 'Paused by owner' : 'Active'
}

/**
 * The one control an admin has: Resume while an admin pause stands, else Pause.
 * A pause by the owner is the owner's switch; an admin can still add an admin pause.
 */
export function adminControl(entry: Pick<WebhookAdminEntry, 'adminPause'>): 'pause' | 'resume' {
  return entry.adminPause ? 'resume' : 'pause'
}

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<WebhookDeliveryOutcome>([
  'pending', 'ran', 'partial', 'failed', 'filtered', 'duplicate', 'unverified', 'not_allowed', 'paused',
])
const FAILING_OUTCOMES: ReadonlySet<string> = new Set(['partial', 'failed', 'unverified', 'not_allowed'])

function isKnownOutcome(outcome: string): outcome is WebhookDeliveryOutcome {
  return KNOWN_OUTCOMES.has(outcome)
}

/** An outcome the host names; a newer one this app does not know shows as the host wrote it. */
export function adminOutcomeLabel(outcome: string): string {
  return isKnownOutcome(outcome) ? outcomeLabel(outcome) : outcome
}

/** The last delivery of a row: its outcome and how long ago. */
export function adminLastDeliveryText(last: WebhookAdminEntry['lastDelivery'], now: number): string {
  if (!last) return 'No deliveries yet'
  const age = relativeTime(new Date(last.receivedAt).toISOString(), now)
  return `Last delivery: ${adminOutcomeLabel(last.outcome)}, ${age === '<1m' ? 'now' : `${age} ago`}`
}

export interface AdminWebhookRow {
  /** Host and webhook: one webhook id on two hosts is two rows. */
  readonly key: string
  readonly title: string
  readonly state: string
  readonly stateTone: 'muted' | 'danger'
  readonly lines: readonly RowLine[]
  readonly control: 'pause' | 'resume'
  readonly ref: WebhookAdminRef
}

export function adminWebhookRow(entry: WebhookAdminEntry, organizationId: string, now: number): AdminWebhookRow {
  const project = projectName(entry.projectName)
  const failing = entry.lastDelivery !== null && FAILING_OUTCOMES.has(entry.lastDelivery.outcome)
  return {
    key: `${entry.hostId}\u0000${entry.webhookId}`,
    title: entry.name,
    state: adminStateLabel(entry),
    stateTone: entry.adminPause ? 'danger' : 'muted',
    lines: [
      { text: [entry.hostLabel, project].filter(Boolean).join(' · ') },
      { text: `Owner: ${entry.ownerName ?? entry.ownerUserId}` },
      { text: adminLastDeliveryText(entry.lastDelivery, now), tone: failing ? 'danger' : 'muted' },
      { text: deliveries24hText(entry.deliveriesLast24Hours) },
    ],
    control: adminControl(entry),
    ref: { organizationId, hostId: entry.hostId, webhookId: entry.webhookId },
  }
}

/** The text of a Pause or Resume that did not complete, shown on its row. */
export function adminActionErrorText(control: 'pause' | 'resume', outcome: WebhookAdminOutcome<null> | null): string {
  const verb = control === 'pause' ? 'Not paused' : 'Not resumed'
  if (outcome && !outcome.ok) return `${verb}. ${adminRefusalText(outcome.error)}`
  return `${verb}. ${ADMIN_FAILED_TEXT}`
}
