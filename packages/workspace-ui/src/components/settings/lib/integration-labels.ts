import { firstPartyClientById } from '@solus/contracts/first-party-clients'
import { integrationUrlSchema, solusServerIdOf, type IntegrationConnection, type IntegrationProbeResult } from '@solus/contracts/integration-types'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'

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

/** "3 tools are ready" for the connect dialog's last step. */
export function readyToolsText(count: number): string {
  if (count === 0) return 'No tools are on. Agents get none from this server.'
  return `${count} ${count === 1 ? 'tool is' : 'tools are'} ready for the next run`
}

/**
 * Where the connect dialog stands for one server (docs/integrations.md):
 * `adding` until the host has the record, then the administrator's OAuth client
 * when the server needs one, then the person's sign-in, then the tools to keep on.
 * A server without sign-in goes straight to its tools.
 */
export type ConnectStep = 'adding' | 'oauth-client' | 'sign-in' | 'tools'

export interface IntegrationStatusText {
  text: string
  tone: 'ready' | 'attention' | 'error'
  /** The row shows Connect or Reconnect beside the status. */
  canConnect: boolean
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
  /** The one action that changes this state; null when no sign-in would change it. */
  action: 'Connect' | 'Reconnect' | 'Disconnect' | null
}

/**
 * The caller's own connection to an integration, in words (mcp-integrations.md
 * §4.1 rule 5). A connection held in the account says so (plans/020 §5), and a
 * cloud the host could not reach is not a sign-in problem: no Connect for it.
 */
export function connectionStatusText(connection: IntegrationConnection | null): ConnectionStatusText {
  if (!connection) return { text: 'Not connected', detail: null, action: 'Connect' }
  switch (connection.status) {
    case 'connected': {
      const account = connection.label?.trim() || connection.info?.displayName?.trim() || connection.info?.email?.trim()
      if (connection.source === 'cloud') return { text: account ? `Connected in your Solus account as ${account}` : 'Connected in your Solus account', detail: null, action: 'Disconnect' }
      return { text: account ? `Connected as ${account}` : 'Connected', detail: null, action: 'Disconnect' }
    }
    case 'needs-sign-in':
      return { text: 'Needs sign-in', detail: connection.error, action: 'Reconnect' }
    case 'error':
      return { text: 'Connection error', detail: connection.error, action: 'Reconnect' }
    case 'cloud-unreachable':
      return { text: 'Solus Cloud unreachable', detail: connection.error, action: null }
    case 'needs-solus-sign-in':
      return { text: 'Sign in to Solus', detail: connection.error, action: null }
  }
}

/** The host part of an integration's address, or the address when it does not parse. */
export function urlHost(url: string): string {
  // A Solus MCP server runs inside the host and has no address of its own (§13.6).
  if (solusServerIdOf(url)) return 'Built by Solus'
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
  | { state: 'automatic'; message: string }
  | { state: 'missing'; connectHint: string }
  | { state: 'set'; message: string; clientId: string; secret: string; changeHint: string | null }

/**
 * One installed server as the desktop and web settings word it: the shared
 * sign-in rules (`IntegrationSignIn`) and this client's text for them.
 */
export class IntegrationLabels extends IntegrationSignIn {
  /** Where the connect dialog stands once the host has the record. */
  connectStep(connection: IntegrationConnection | null): Exclude<ConnectStep, 'adding'> {
    if (this.canListTools(connection)) return 'tools'
    return this.needsOwnerClient ? 'oauth-client' : 'sign-in'
  }

  /** The server's state in a few words, for its row in the MCP list. */
  statusText(connection: IntegrationConnection | null): IntegrationStatusText {
    if (!this.needsConnection) return { text: 'Ready', tone: 'ready', canConnect: false }
    if (this.needsOwnerClient && connection?.status !== 'connected') return { text: 'Needs an OAuth client', tone: 'attention', canConnect: false }
    const status = connectionStatusText(connection)
    if (connection?.status === 'connected') return { text: status.text, tone: 'ready', canConnect: false }
    return { text: status.text, tone: connection ? 'error' : 'attention', canConnect: status.action !== null }
  }

  /**
   * The OAuth client line. Manual client setup is available for every OAuth
   * server; it blocks sign-in only when the server cannot register a client
   * automatically.
   */
  get clientText(): OAuthClientText | null {
    const { auth } = this.integration
    if (auth.kind !== 'oauth') return null
    const firstParty = this.firstParty
    // A Solus app signs in; the owner may still use their own (§13.1).
    if (firstParty) return { state: 'automatic', message: `Signs in with ${firstPartyClientById(firstParty).label}. Use your own OAuth app instead` }
    if (!auth.clientId && auth.registration !== 'client-required') return { state: 'automatic', message: 'Use your own OAuth app' }
    if (!auth.clientId) {
      return {
        state: 'missing',
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
}

/**
 * The service's logo for a server address, from the integrations.sh logo
 * service the catalog already uses. It resolves a subdomain such as
 * `bindings.mcp.cloudflare.com` to its service.
 */
export function serverIconUrl(url: string): string {
  return `https://integrations.sh/logo/${encodeURIComponent(URL.canParse(url) ? new URL(url).hostname : url)}`
}
