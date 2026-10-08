import { integrationUrlSchema, type IntegrationAuth, type IntegrationConnection, type IntegrationProbeResult } from '@solus/contracts/integration-types'

type UndeterminedReason = Extract<IntegrationProbeResult, { outcome: 'undetermined' }>['reason']

const UNDETERMINED_REASONS = {
  unavailable: 'The server is not available now.',
  unreachable: 'Solus cannot reach this address.',
  timeout: 'The server did not answer in time.',
  redirected: 'This address sends Solus to a different address. Use the final address.',
  refused: 'The server refused the request.',
  not_mcp: 'This address is not an MCP server.',
  initialize_error: 'The server did not start an MCP session.',
  tools_error: 'The server did not list its tools.',
  oauth_unusable: 'The server asks for sign-in, but Solus cannot use its sign-in settings.',
} satisfies { [reason in UndeterminedReason]: string }

/** Why a probed server cannot be added, or null when it can (mcp-integrations.md §3.2). */
export function probeRefusal(result: IntegrationProbeResult): string | null {
  return result.outcome === 'undetermined' ? UNDETERMINED_REASONS[result.reason] : null
}

/** What runs right after Add: a sign-in, the administrator's OAuth client form, or nothing. */
export function afterAddStep(auth: IntegrationAuth): 'ready' | 'connect' | 'oauth-client' {
  if (auth.kind === 'none') return 'ready'
  if (auth.kind === 'oauth' && auth.registration === 'client-required' && !auth.clientId) return 'oauth-client'
  return 'connect'
}

/**
 * The host lists tools only for a server that works without sign-in or that the
 * person is connected to. Asking for any other is an error, not a list.
 */
export function canListTools(auth: IntegrationAuth, connection: IntegrationConnection | null): boolean {
  return auth.kind === 'none' || connection?.status === 'connected'
}

export interface IntegrationStatusText {
  text: string
  tone: 'ready' | 'attention' | 'error'
  /** The row shows Connect or Reconnect beside the status. */
  canConnect: boolean
}

/** One installed server's state in a few words, for its row in the MCP list. */
export function integrationStatusText(auth: IntegrationAuth, connection: IntegrationConnection | null): IntegrationStatusText {
  if (auth.kind === 'none') return { text: 'Ready', tone: 'ready', canConnect: false }
  if (afterAddStep(auth) === 'oauth-client' && connection?.status !== 'connected') return { text: 'Needs an OAuth client', tone: 'attention', canConnect: false }
  const status = connectionStatusText(connection)
  if (connection?.status === 'connected') return { text: status.text, tone: 'ready', canConnect: false }
  return { text: status.text, tone: connection ? 'error' : 'attention', canConnect: true }
}

/** "1,306 servers" for the whole catalog, or every match of a query. */
export function catalogCountText(total: number): string {
  return `${total.toLocaleString('en-US')} ${total === 1 ? 'server' : 'servers'}`
}

export interface ConnectionStatusText {
  /** The state in words, for example "Connected as Ada". */
  text: string
  /** Why the connection does not work, when the host said. */
  detail: string | null
  /** The one action that changes this state. */
  action: 'Connect' | 'Reconnect' | 'Disconnect'
}

/** The caller's own connection to an integration, in words (mcp-integrations.md §4.1 rule 5). */
export function connectionStatusText(connection: IntegrationConnection | null): ConnectionStatusText {
  if (!connection) return { text: 'Not connected', detail: null, action: 'Connect' }
  switch (connection.status) {
    case 'connected': {
      const account = connection.label?.trim() || connection.info?.displayName?.trim() || connection.info?.email?.trim()
      return { text: account ? `Connected as ${account}` : 'Connected', detail: null, action: 'Disconnect' }
    }
    case 'needs-sign-in':
      return { text: 'Needs sign-in', detail: connection.error, action: 'Reconnect' }
    case 'error':
      return { text: 'Connection error', detail: connection.error, action: 'Reconnect' }
  }
}

/** The host part of an integration's address, or the address when it does not parse. */
export function urlHost(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url
}

/** The first non-empty line of a tool description. */
export function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
}

/** Why a typed address cannot be an integration, or null when it can. */
export function customUrlProblem(url: string): string | null {
  if (!url.trim()) return 'Type the address of an MCP server.'
  return integrationUrlSchema.safeParse(url).success ? null : 'Use an HTTPS address with no credentials or fragment.'
}

/** The host path a service's OAuth app must list as its redirect URL. */
const INTEGRATION_OAUTH_CALLBACK_PATH = '/oauth/integration/callback'

/** The redirect URL to enter at the service, on the origin this client reaches the host on. */
export function oauthRedirectUrl(hostOrigin: string): string {
  return `${hostOrigin}${INTEGRATION_OAUTH_CALLBACK_PATH}`
}

export type OAuthClientText =
  | { state: 'missing'; message: string; connectHint: string }
  | { state: 'set'; message: string; clientId: string; secret: string; changeHint: string | null }

/**
 * The administrator's OAuth client of a server with no dynamic registration
 * (mcp-integrations.md §4.3), in words. Null when the server needs no client.
 */
export function oauthClientText(auth: IntegrationAuth): OAuthClientText | null {
  if (auth.kind !== 'oauth' || auth.registration !== 'client-required') return null
  if (!auth.clientId) {
    return {
      state: 'missing',
      message: 'This server needs an OAuth client. Create one at the service and enter it here.',
      connectHint: 'Enter the OAuth client first',
    }
  }
  // Save replaces the whole client on the host, so a saved secret must be typed again to stay.
  return {
    state: 'set',
    message: 'OAuth client set',
    clientId: auth.clientId,
    secret: auth.hasClientSecret ? 'Secret saved' : 'No secret',
    changeHint: auth.hasClientSecret ? 'Enter the secret again to keep it. An empty field saves no secret.' : null,
  }
}

/**
 * The service's logo for a server address, from the integrations.sh logo
 * service the catalog already uses. It resolves a subdomain such as
 * `bindings.mcp.cloudflare.com` to its service.
 */
export function serverIconUrl(url: string): string {
  return `https://integrations.sh/logo/${encodeURIComponent(URL.canParse(url) ? new URL(url).hostname : url)}`
}
