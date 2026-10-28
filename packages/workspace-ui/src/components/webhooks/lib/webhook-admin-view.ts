import type { WebhookAdminEntry, WebhookAdminError, WebhookAdminRef } from '@solus/contracts/webhook-admin'
import type { WebhookActionType, WebhookDeliveryOutcome } from '@solus/contracts/webhooks'
import { urlModeLabel } from './webhook-reachability'
import { actionTypeLabel, isFailingOutcome, OUTCOME_FILTERS, outcomeLabel } from './webhooks-view'

/**
 * The Organization view of Settings → Webhooks (docs/plans/webhooks.md §2.7, §4):
 * the organization webhooks of all members, read from the organization's Solus
 * API. An admin can pause and resume them; nothing else. Pure, so the rules are
 * tested without a Solus API.
 */

export const WEBHOOK_ADMIN_FAILED_TEXT = 'The Solus API did not answer. Try again.'
export const WEBHOOK_ADMIN_EMPTY_TEXT = 'No organization webhooks yet.'
export const WEBHOOK_ADMIN_LOADING_TEXT = 'Loading organization webhooks…'

/** Why the Solus API refused, in words. */
export function webhookAdminRefusalText(error: WebhookAdminError): string {
  switch (error) {
    case 'not_organization_admin': return 'Only an organization admin can see this view.'
    case 'host_not_of_organization': return 'That host does not deliver to this organization.'
  }
}

export type WebhookAdminState = 'active' | 'paused' | 'admin-paused'

/** An admin pause comes first: only an admin can end it. */
export function webhookAdminState(entry: WebhookAdminEntry): WebhookAdminState {
  if (entry.adminPause) return 'admin-paused'
  return entry.state
}

export function webhookAdminStateLabel(state: WebhookAdminState): string {
  switch (state) {
    case 'active': return 'Active'
    case 'paused': return 'Paused by owner'
    case 'admin-paused': return 'Paused by organization admin'
  }
}

/** One key for a webhook of the organization: two hosts can hold the same id. */
export function webhookAdminKey(ref: WebhookAdminRef): string {
  return `${ref.organizationId}\n${ref.hostId}\n${ref.webhookId}`
}

const ACTION_TYPES: readonly WebhookActionType[] = ['start_session', 'send_to_session', 'run_automation']

/** A type that this client does not know (a newer host) shows as it is. */
function actionTypeText(type: string): string {
  const known = ACTION_TYPES.find((choice) => choice === type)
  return known ? actionTypeLabel(known) : type
}

function knownOutcome(outcome: string): WebhookDeliveryOutcome | null {
  const known = OUTCOME_FILTERS.find((choice) => choice === outcome)
  return known && known !== 'failing' && known !== 'never' ? known : null
}

/** One row of the Organization table. */
export interface WebhookAdminRow {
  key: string
  ref: WebhookAdminRef
  name: string
  hostLabel: string
  owner: string
  project: string
  urlMode: string
  state: WebhookAdminState
  stateLabel: string
  actionTypes: string
  lastDelivery: { outcome: string; isFailing: boolean; at: number } | null
  deliveries24h: number
  /** An admin pause shows Resume; any other state shows Pause. */
  action: 'pause' | 'resume'
}

export function webhookAdminRow(organizationId: string, entry: WebhookAdminEntry): WebhookAdminRow {
  const ref = { organizationId, hostId: entry.hostId, webhookId: entry.webhookId }
  const state = webhookAdminState(entry)
  const outcome = entry.lastDelivery ? knownOutcome(entry.lastDelivery.outcome) : null
  return {
    key: webhookAdminKey(ref),
    ref,
    name: entry.name,
    hostLabel: entry.hostLabel || entry.hostId,
    owner: entry.ownerName ?? entry.ownerUserId,
    project: entry.projectName ?? 'No project',
    urlMode: urlModeLabel(entry.urlMode),
    state,
    stateLabel: webhookAdminStateLabel(state),
    actionTypes: entry.actionTypes.length ? [...new Set(entry.actionTypes)].map(actionTypeText).join(', ') : 'No actions',
    lastDelivery: entry.lastDelivery
      ? {
          outcome: outcome ? outcomeLabel(outcome) : entry.lastDelivery.outcome,
          isFailing: outcome ? isFailingOutcome(outcome) : false,
          at: entry.lastDelivery.receivedAt,
        }
      : null,
    deliveries24h: entry.deliveriesLast24Hours,
    action: entry.adminPause ? 'resume' : 'pause',
  }
}

/** Sorted by name, then by host, as the host table is. */
export function webhookAdminRows(organizationId: string, entries: readonly WebhookAdminEntry[]): WebhookAdminRow[] {
  return entries
    .map((entry) => webhookAdminRow(organizationId, entry))
    .sort((a, b) => a.name.localeCompare(b.name) || a.hostLabel.localeCompare(b.hostLabel))
}

/**
 * The organization the view shows: the one in the page URL when the person is
 * a member, else the window's organization, else the first one. Null with none.
 */
export function chosenAdminOrganization(
  organizationIds: readonly string[],
  fromUrl: string | null,
  active: string | null,
): string | null {
  if (fromUrl && organizationIds.includes(fromUrl)) return fromUrl
  if (active && organizationIds.includes(active)) return active
  return organizationIds[0] ?? null
}
