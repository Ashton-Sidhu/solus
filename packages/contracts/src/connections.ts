// ─── Connections ───
//
// A connection is the link between Solus and one external account. It is
// *established* by the user and only ever *observed* by an agent: the tool
// reports status and can raise a request, but the token or OAuth round-trip
// belongs to the user, in the card, never in the chat.
//
// One vocabulary for three providers that behave differently underneath. See
// `docs/plans/config-overhaul.md`.

/** Every account Solus connects to, addressed by one name everywhere. */
export const CONNECTION_PROVIDERS = ['github', 'atlassian', 'google'] as const
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number]

/** Display names, so no surface has to invent its own capitalization. */
export const CONNECTION_LABELS: Record<ConnectionProvider, string> = {
  github: 'GitHub',
  atlassian: 'Atlassian',
  google: 'Google Drive',
}

/**
 * Why the agent needs the connection, in the user's terms. The card shows this,
 * so an agent that asks for Atlassian while the user said "set up Jira" does
 * not answer with a word the user did not use.
 *
 * Confluence and Jira share one Atlassian connection by design, so both name
 * `atlassian` as their provider and differ only here.
 */
export type ConnectionReason =
  | 'pull-requests'
  | 'issues'
  | 'confluence'
  | 'jira'
  | 'drive'
  | 'unspecified'

export interface ConnectionConnectNeeded {
  /** Account settings URL for account-owned integrations; never contains credentials. */
  accountConnectionsUrl?: string
  provider: ConnectionProvider
  reason: ConnectionReason
  /** The Solus session whose turn is waiting on the connection. */
  sessionId: string
}

export function isConnectionProvider(value: string): value is ConnectionProvider {
  return (CONNECTION_PROVIDERS as readonly string[]).includes(value)
}
