import type {
  CatalogEntry,
  Integration,
  IntegrationAuthFinishedEvent,
  IntegrationConnection,
  IntegrationConnectStartResult,
  IntegrationProbeResult,
  IntegrationToolSummary,
} from '@solus/contracts/integration-types'

/**
 * The MCP servers of one host (docs/plans/mcp-integrations.md §7), as the
 * mobile MCP screen shows them: the installed servers with one status line
 * each, the tools of the ones the person opened, the paged catalog, and the
 * one-step add (probe, then create, then sign-in when the server needs it),
 * and the person's own connection to each one that needs sign-in (§4): its
 * status, and the connect flow the row and the conversation's connect sheet
 * both run.
 */

export type IntegrationListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; integrations: Integration[] }
  | { kind: 'error'; message: string }
  /** An older host that has no integration methods. */
  | { kind: 'unsupported' }

export type IntegrationToolsState =
  | { kind: 'loading' }
  | { kind: 'loaded'; tools: IntegrationToolSummary[] }
  | { kind: 'error'; message: string }

/** One page of the catalog search. `total` counts every match of the query. */
export type CatalogState =
  | { kind: 'idle' }
  | { kind: 'loading'; query: string }
  /**
   * `loadingMore`: the next entries are loading below the ones shown.
   * `searching`: a new query runs; the last answer stays, dimmed, until it arrives.
   */
  | { kind: 'loaded'; query: string; entries: CatalogEntry[]; total: number; loadingMore: boolean; searching: boolean }
  | { kind: 'error'; query: string; message: string }

export const CATALOG_PAGE_SIZE = 24

/** The server the person chose to add: a catalog entry or a URL they typed. */
export interface IntegrationCandidate {
  name: string
  url: string
  /** The catalog's slug; absent for a custom URL, so the host derives one from the name. */
  slug?: string
}

/**
 * The one add in progress, by the address it adds. `checking`: the probe or
 * the create runs. `failed`: nothing was created; the entry says why and
 * offers Retry.
 */
export type AddState =
  | { url: string; step: 'checking' }
  | { url: string; step: 'failed'; message: string }

/** The one change in flight, so its control shows progress and the others wait. */
export type IntegrationAction = 'create' | `rename:${string}` | `remove:${string}` | `disconnect:${string}` | `oauth-client:${string}`

export const UNSUPPORTED_NOTE = 'This host does not support MCP servers. Update Solus on it.'

/** True for the error an older host gives for a method it does not have. */
export function isUnsupportedMethodError(message: string): boolean {
  return /unknown method|no handler for|not registered|not a function/i.test(message)
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The list in name order, with `integration` added or replaced. */
export function upsertIntegration(list: readonly Integration[], integration: Integration): Integration[] {
  const others = list.filter((entry) => entry.id !== integration.id)
  return sortIntegrations([...others, integration])
}

export function withoutIntegration(list: readonly Integration[], integrationId: string): Integration[] {
  return list.filter((entry) => entry.id !== integrationId)
}

export function sortIntegrations(list: Integration[]): Integration[] {
  return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** The installed servers that match the search by name, slug, or address. An empty search keeps all. */
export function filterInstalled(list: readonly Integration[], query: string): Integration[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...list]
  return list.filter((integration) =>
    [integration.name, integration.slug, urlHost(integration.url), integration.url]
      .some((field) => field.toLowerCase().includes(needle)))
}

/** True when an installed server already uses this address, so the catalog says Added. */
export function isInstalled(list: readonly Integration[], url: string): boolean {
  const target = url.trim()
  return list.some((integration) => integration.url === target)
}

type UndeterminedReason = Extract<IntegrationProbeResult, { outcome: 'undetermined' }>['reason']

const UNDETERMINED_REASON = {
  unavailable: 'The host cannot check servers now.',
  unreachable: 'The host cannot reach this address.',
  timeout: 'The server did not answer in time.',
  redirected: 'The server sent the request to a different address. Solus does not follow it.',
  refused: 'The server refused the request.',
  not_mcp: 'This address does not answer as an MCP server.',
  initialize_error: 'The server did not start an MCP session.',
  tools_error: 'The server did not send its list of tools.',
  oauth_unusable: 'The server asks for sign-in, but Solus cannot use its sign-in details.',
} satisfies Record<UndeterminedReason, string>

/** Why the probe stops the add, or null when the server can be added. */
export function probeRefusal(result: IntegrationProbeResult): string | null {
  return result.outcome === 'undetermined' ? UNDETERMINED_REASON[result.reason] : null
}

/**
 * What the screen does once a server is created: start the person's sign-in,
 * open the row on the OAuth client form an administrator must fill first, or
 * nothing for a server that works without sign-in.
 */
export type AfterCreate = 'connect' | 'oauth-client' | 'none'

export function afterCreate(integration: Pick<Integration, 'auth'>): AfterCreate {
  if (isMissingOAuthClient(integration)) return 'oauth-client'
  return needsConnection(integration) ? 'connect' : 'none'
}

/** "1,306 servers" for the whole catalog, or every match of a query. */
export function catalogCountText(total: number): string {
  return `${groupDigits(total)} ${total === 1 ? 'server' : 'servers'}`
}

/** The shown entries with the next page below them; an entry already shown is not repeated. */
export function appendCatalogEntries(shown: readonly CatalogEntry[], next: readonly CatalogEntry[]): CatalogEntry[] {
  const ids = new Set(shown.map((entry) => entry.id))
  return [...shown, ...next.filter((entry) => !ids.has(entry.id))]
}

/** The catalog loads more this far before the end of the scroll, so the person rarely waits. */
const LOAD_MORE_DISTANCE = 400

export function isNearEnd(viewHeight: number, scrolledY: number, contentHeight: number): boolean {
  return viewHeight + scrolledY >= contentHeight - LOAD_MORE_DISTANCE
}

/** Thousands separators without `Intl`, which React Native implements only in part. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** The first line of a tool's description, for a one-line row. */
export function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
}

/**
 * The same rule as `integrationUrlSchema`: an HTTPS address with no
 * credentials, fragment, or placeholder. A query is allowed. Written without `URL`,
 * which React Native implements only in part.
 */
export function isIntegrationUrl(input: string): boolean {
  const value = input.trim()
  if (value.length === 0 || value.length > 4096) return false
  if (/[{}]|%7b|%7d/i.test(value)) return false
  if (/[\s#]/.test(value)) return false
  const match = /^https:\/\/([^/?]*)([/?].*)?$/i.exec(value)
  if (!match) return false
  const authority = match[1]!
  if (authority.includes('@')) return false
  return /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/i.test(authority)
}

/** True when the person seems to type an address rather than a search. */
export function looksLikeUrl(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim())
}

/** The host part of an address, for a one-line row; the address itself when it has none. */
export function urlHost(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+|\[[^\]]+\])/i.exec(url.trim())
  return match?.[1] ?? url
}

/** A custom URL is added under the name of its host; the person may rename it later. */
export function customCandidate(url: string): IntegrationCandidate {
  const trimmed = url.trim()
  return { name: urlHost(trimmed), url: trimmed }
}

export function catalogCandidate(entry: CatalogEntry): IntegrationCandidate {
  return { name: entry.name, url: entry.url, slug: entry.slug }
}

// ─── The administrator's OAuth client (§4.3) ───

/** The path on the host's HTTP server that the service's OAuth app lists as its redirect URL. */
export const OAUTH_CALLBACK_PATH = '/oauth/integration/callback'

export const oauthClientText = {
  title: 'OAuth client',
  explanation: 'This server does not let Solus register itself. Create an OAuth app at the service, then enter its client ID and secret here. Each person still signs in with their own account.',
  redirectLabel: 'Redirect URL',
  redirectNote: 'Add this path, on the host\'s address, to the redirect URLs of the OAuth app.',
  clientIdLabel: 'Client ID',
  clientSecretLabel: 'Client secret',
  clientSecretNote: 'Optional. The secret stays on the host. Agents and clients never see it.',
  changeSecretNote: 'Enter the secret again. A blank secret saves the client with no secret.',
  secretSaved: 'Secret saved',
  noSecret: 'No secret',
  save: 'Save',
  change: 'Change',
  remove: 'Remove',
  removeTitle: 'Remove the OAuth client?',
  removeDetail: 'No one can connect until an administrator enters a client again.',
  connectBlocked: 'Enter the OAuth client first',
} as const

/** True for an OAuth server that has no dynamic registration, so an administrator enters its client. */
export function needsOAuthClient(integration: Pick<Integration, 'auth'>): boolean {
  return integration.auth.kind === 'oauth' && integration.auth.registration === 'client-required'
}

/** True when the person cannot connect yet, because the administrator's client is missing. */
export function isMissingOAuthClient(integration: Pick<Integration, 'auth'>): boolean {
  const { auth } = integration
  return auth.kind === 'oauth' && auth.registration === 'client-required' && !auth.clientId
}

// ─── The person's connection (§4) ───

export type ConnectionListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; byIntegration: ReadonlyMap<string, IntegrationConnection> }
  | { kind: 'error'; message: string }
  /** An older host that has no connection methods. */
  | { kind: 'unsupported' }

export function connectionMap(connections: readonly IntegrationConnection[]): ReadonlyMap<string, IntegrationConnection> {
  return new Map(connections.map((connection) => [connection.integrationId, connection]))
}

/** The map with one connection replaced, or removed when `connection` is null. */
export function withConnection(
  byIntegration: ReadonlyMap<string, IntegrationConnection>,
  integrationId: string,
  connection: IntegrationConnection | null,
): ReadonlyMap<string, IntegrationConnection> {
  const next = new Map(byIntegration)
  if (connection) next.set(integrationId, connection)
  else next.delete(integrationId)
  return next
}

/** Only an integration with sign-in has a per-person connection. */
export function needsConnection(integration: Pick<Integration, 'auth'>): boolean {
  return integration.auth.kind !== 'none'
}

/**
 * The one status line of an installed server, and the connect action the row
 * shows without opening. A connection still being read says so rather than
 * claiming Not connected.
 */
export interface InstalledStatus {
  text: string
  tone: 'muted' | 'danger'
  action: 'connect' | 'reconnect' | null
}

export function installedStatus(integration: Pick<Integration, 'id' | 'auth'>, connections: ConnectionListState): InstalledStatus {
  if (!needsConnection(integration)) return { text: 'Ready', tone: 'muted', action: null }
  if (connections.kind === 'loading') return { text: 'Checking connection…', tone: 'muted', action: null }
  if (connections.kind !== 'loaded') return { text: 'Connection unknown', tone: 'muted', action: null }
  const connection = connections.byIntegration.get(integration.id)
  if (connection?.status === 'connected') {
    const label = connection.label ?? connection.info?.displayName ?? connection.info?.email ?? null
    return { text: label ? `Connected as ${label}` : 'Connected', tone: 'muted', action: null }
  }
  if (isMissingOAuthClient(integration)) return { text: 'Needs an OAuth client', tone: 'danger', action: null }
  if (!connection) return { text: 'Not connected', tone: 'muted', action: 'connect' }
  if (connection.status === 'needs-sign-in') return { text: 'Needs sign-in', tone: 'danger', action: 'reconnect' }
  return { text: 'Connection error', tone: 'danger', action: 'reconnect' }
}

/**
 * Tools are read only from a server that can answer: one without sign-in, or
 * one the person is connected to. Any other server would only return an error.
 */
export function mayLoadTools(integration: Pick<Integration, 'id' | 'auth'>, connections: ConnectionListState): boolean {
  if (!needsConnection(integration)) return true
  return connections.kind === 'loaded' && connections.byIntegration.get(integration.id)?.status === 'connected'
}

/**
 * One sign-in in progress (§4.3). `waiting`: the host waits for the browser;
 * `redirect-url` also asks for the address the browser ended on, which is the
 * usual case on a phone, as its browser cannot reach the host. `token`: the
 * integration takes an API key. No entry means no flow.
 */
export type ConnectFlowState =
  | { step: 'starting' }
  | {
      step: 'waiting'
      flowId: string
      url: string
      input: 'callback' | 'redirect-url'
      expiresAt: string
      submitted: boolean
      busy: boolean
      error: string | null
    }
  | { step: 'token'; busy: boolean; error: string | null }
  | { step: 'finished'; ok: boolean; message: string }

/** What the host answered to Connect. */
export function connectStarted(result: IntegrationConnectStartResult, name: string): ConnectFlowState {
  switch (result.kind) {
    case 'waiting':
      return { step: 'waiting', flowId: result.flowId, url: result.url, input: result.input, expiresAt: result.expiresAt, submitted: false, busy: false, error: null }
    case 'token':
      return { step: 'token', busy: false, error: null }
    case 'connected':
      return { step: 'finished', ok: true, message: `Connected to ${name}.` }
  }
}

/** Connect itself failed: the host refused or could not be reached. */
export function connectRefused(message: string): ConnectFlowState {
  return { step: 'finished', ok: false, message }
}

/** The address or the key is on its way to the host. */
export function connectSubmitting(state: ConnectFlowState): ConnectFlowState {
  return state.step === 'waiting' || state.step === 'token' ? { ...state, busy: true, error: null } : state
}

/**
 * The host took the value. A waiting flow still ends on
 * `host.integrationAuthFinished`; a stored key is the end.
 */
export function connectSubmitted(state: ConnectFlowState, name: string): ConnectFlowState {
  if (state.step === 'waiting') return { ...state, busy: false, submitted: true }
  if (state.step === 'token') return { step: 'finished', ok: true, message: `Connected to ${name}.` }
  return state
}

/** A submit, a cancel, or the browser failed; the flow stays open and says why. */
export function connectFailed(state: ConnectFlowState, message: string): ConnectFlowState {
  return state.step === 'waiting' || state.step === 'token' ? { ...state, busy: false, error: message } : state
}

/**
 * The host ended a waiting flow. An event for another flow changes nothing;
 * a cancelled flow closes (null), as the person or another of their clients
 * chose it.
 */
export function connectFinished(state: ConnectFlowState, event: IntegrationAuthFinishedEvent, name: string): ConnectFlowState | null {
  if (state.step !== 'waiting' || state.flowId !== event.flowId) return state
  switch (event.outcome) {
    case 'connected': return { step: 'finished', ok: true, message: event.message ?? `Connected to ${name}.` }
    case 'failed': return { step: 'finished', ok: false, message: event.message ?? `${name} did not connect.` }
    case 'cancelled': return null
  }
}

/** After a reset the end of a waiting flow may have been sent while this client was away; it starts over. */
export function connectReset(state: ConnectFlowState): ConnectFlowState {
  return state.step === 'waiting' ? { step: 'finished', ok: false, message: 'The connection to the host was reset. Connect again.' } : state
}

/**
 * The service's logo for a server address, from the integrations.sh logo
 * service the catalog already uses. It resolves a subdomain such as
 * `bindings.mcp.cloudflare.com` to its service.
 */
export function serverIconUrl(url: string): string {
  return `https://integrations.sh/logo/${encodeURIComponent(URL.canParse(url) ? new URL(url).hostname : url)}`
}
