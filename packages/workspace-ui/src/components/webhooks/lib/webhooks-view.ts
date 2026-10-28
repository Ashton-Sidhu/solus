import type { Webhook, WebhookActionType, WebhookDeliveryOutcome, WebhookUrlMode } from '@solus/contracts/webhooks'
import { attributionLabel } from '@solus/contracts/user'
import { hostPathBaseName, sameHostPath } from '@solus/contracts/host-path'

/**
 * The Webhooks page's view (docs/plans/webhooks.md §4): its filters and the
 * webhook it opens. It is kept in the page URL as query text, so a link opens
 * the same view. Pure, so the rules are tested without a host.
 */

export type WebhookState = 'active' | 'paused' | 'admin-paused'
/** `failing` is a failed, partial, or unverified last delivery. */
export type WebhookOutcomeFilter = 'failing' | 'never' | WebhookDeliveryOutcome

/** `hosts`: the webhooks of every connected host. `organization`: an organization's webhooks of all members, read from its Solus API (plan §2.7). */
export type WebhooksScope = 'hosts' | 'organization'

/** What the view opens: a saved webhook on one host, or the editor for a new one. */
export type WebhookOpenTarget =
  | { kind: 'webhook'; serverId: string; webhookId: string }
  | { kind: 'new'; serverId: string | null }

export interface WebhooksView {
  scope: WebhooksScope
  /** The organization the Organization view shows; null is the window's organization. */
  adminOrganization: string | null
  query: string
  host: string | null
  project: string | null
  state: WebhookState | null
  outcome: WebhookOutcomeFilter | null
  urlMode: WebhookUrlMode | null
  /** An owner key. */
  owner: string | null
  organization: string | null
  open: WebhookOpenTarget | null
}

/** One webhook in the table, with the host it lives on. */
export interface WebhookRow {
  serverId: string
  webhook: Webhook
}

export const EMPTY_WEBHOOKS_VIEW: WebhooksView = {
  scope: 'hosts',
  adminOrganization: null,
  query: '',
  host: null,
  project: null,
  state: null,
  outcome: null,
  urlMode: null,
  owner: null,
  organization: null,
  open: null,
}

const STATES: readonly WebhookState[] = ['active', 'paused', 'admin-paused']
const OUTCOMES: readonly WebhookOutcomeFilter[] = [
  'failing', 'never', 'pending', 'ran', 'partial', 'failed', 'filtered', 'duplicate', 'unverified', 'not_allowed', 'paused',
]
const URL_MODES: readonly WebhookUrlMode[] = ['cloud', 'direct', 'none']
const FAILING: ReadonlySet<WebhookDeliveryOutcome> = new Set<WebhookDeliveryOutcome>(['failed', 'partial', 'unverified'])

function pick<T extends string>(choices: readonly T[], value: string | null): T | null {
  return choices.find((choice) => choice === value) ?? null
}

function parseOpen(params: URLSearchParams): WebhookOpenTarget | null {
  const serverId = params.get('on') || null
  if (params.get('new') === '1') return { kind: 'new', serverId }
  const webhookId = params.get('open')
  return webhookId && serverId ? { kind: 'webhook', serverId, webhookId } : null
}

/** Total: an unknown value is dropped, so an old link still opens. */
export function parseWebhooksView(text: string): WebhooksView {
  const params = new URLSearchParams(text)
  return {
    scope: params.get('view') === 'organization' ? 'organization' : 'hosts',
    adminOrganization: params.get('aorg') || null,
    query: params.get('q') ?? '',
    host: params.get('host') || null,
    project: params.get('project') || null,
    state: pick(STATES, params.get('state')),
    outcome: pick(OUTCOMES, params.get('outcome')),
    urlMode: pick(URL_MODES, params.get('mode')),
    owner: params.get('owner') || null,
    organization: params.get('org') || null,
    open: parseOpen(params),
  }
}

export function serializeWebhooksView(view: WebhooksView): string {
  const params = new URLSearchParams()
  if (view.scope === 'organization') params.set('view', 'organization')
  if (view.adminOrganization) params.set('aorg', view.adminOrganization)
  if (view.query) params.set('q', view.query)
  if (view.host) params.set('host', view.host)
  if (view.project) params.set('project', view.project)
  if (view.state) params.set('state', view.state)
  if (view.outcome) params.set('outcome', view.outcome)
  if (view.urlMode) params.set('mode', view.urlMode)
  if (view.owner) params.set('owner', view.owner)
  if (view.organization) params.set('org', view.organization)
  if (view.open?.kind === 'webhook') {
    params.set('open', view.open.webhookId)
    params.set('on', view.open.serverId)
  } else if (view.open?.kind === 'new') {
    params.set('new', '1')
    if (view.open.serverId) params.set('on', view.open.serverId)
  }
  return params.toString()
}

export function webhookState(webhook: Webhook): WebhookState {
  if (webhook.pausedByAdmin) return 'admin-paused'
  return webhook.enabled ? 'active' : 'paused'
}

export function webhookStateLabel(state: WebhookState): string {
  switch (state) {
    case 'active': return 'Active'
    case 'paused': return 'Paused'
    case 'admin-paused': return 'Paused by organization admin'
  }
}

export function isFailingOutcome(outcome: WebhookDeliveryOutcome): boolean {
  return FAILING.has(outcome)
}

export function outcomeLabel(outcome: WebhookOutcomeFilter): string {
  switch (outcome) {
    case 'failing': return 'Failing'
    case 'never': return 'No deliveries'
    case 'pending': return 'Running'
    case 'ran': return 'Ran'
    case 'partial': return 'Partly failed'
    case 'failed': return 'Failed'
    case 'filtered': return 'Filtered'
    case 'duplicate': return 'Duplicate'
    case 'unverified': return 'Not verified'
    case 'not_allowed': return 'Not allowed'
    case 'paused': return 'Paused'
  }
}

export const OUTCOME_FILTERS: readonly WebhookOutcomeFilter[] = OUTCOMES

/** The person a webhook belongs to, in words. */
export function webhookOwnerLabel(webhook: Webhook): string {
  const createdBy = webhook.createdBy
  if ((createdBy.kind === 'agent' || createdBy.kind === 'automation') && createdBy.for) return createdBy.for.displayName
  return attributionLabel(createdBy)
}

const ACTION_TYPE_LABELS = {
  start_session: 'Start session',
  send_to_session: 'Send to session',
  run_automation: 'Run automation',
} satisfies Record<WebhookActionType, string>

export function actionTypeLabel(type: WebhookActionType): string {
  return ACTION_TYPE_LABELS[type]
}

/** "3 actions: Start session, Run automation". */
export function actionsSummary(webhook: Webhook): string {
  const types = [...new Set(webhook.actions.map((action) => action.type))].map(actionTypeLabel)
  const count = webhook.actions.length
  return `${count} ${count === 1 ? 'action' : 'actions'}: ${types.join(', ')}`
}

function matchesOutcome(webhook: Webhook, outcome: WebhookOutcomeFilter): boolean {
  const last = webhook.lastDelivery?.outcome
  if (outcome === 'never') return !last
  if (!last) return false
  return outcome === 'failing' ? isFailingOutcome(last) : last === outcome
}

function matchesQuery(webhook: Webhook, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const text = `${webhook.name}\n${webhook.project ?? ''}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

/** The rows the view shows, in their order. */
export function filterWebhookRows(rows: readonly WebhookRow[], view: WebhooksView): WebhookRow[] {
  return rows.filter(({ serverId, webhook }) =>
    (!view.host || serverId === view.host)
    && (!view.project || (webhook.project !== null && sameHostPath(webhook.project, view.project)))
    && (!view.state || webhookState(webhook) === view.state)
    && (!view.outcome || matchesOutcome(webhook, view.outcome))
    && (!view.urlMode || webhook.urlMode === view.urlMode)
    && (!view.owner || webhook.ownerKey === view.owner)
    && (!view.organization || webhook.organizationId === view.organization)
    && matchesQuery(webhook, view.query))
}

/** The distinct values of one column, for a filter menu: sorted by label. */
export function distinctChoices(rows: readonly WebhookRow[], read: (row: WebhookRow) => { value: string; label: string } | null): { value: string; label: string }[] {
  const byValue = new Map<string, string>()
  for (const row of rows) {
    const choice = read(row)
    if (choice && !byValue.has(choice.value)) byValue.set(choice.value, choice.label)
  }
  return [...byValue].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
}

/** The last folder of a project path, for a narrow column. */
export function projectLabel(project: string | null): string {
  if (!project) return 'No project'
  return hostPathBaseName(project) || project
}
