// ─── Connections ───
//
// A connection is the link between Solus and one external account. It is
// *established* by the user and only ever *observed* by an agent: the tool
// reports status and can raise a request, but the token or OAuth round-trip
// belongs to the user, in the card, never in the chat.
//
// One vocabulary for four providers that behave differently underneath. See
// `docs/plans/config-overhaul.md`.

/** Every account Solus connects to, addressed by one name everywhere. */
export const CONNECTION_PROVIDERS = ['cloudflare', 'github', 'atlassian', 'google'] as const
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number]

/**
 * How a connection is completed. The chassis, the dismissal, and the continue
 * are shared; this is the part that genuinely differs, so it is named rather
 * than flattened.
 *
 * - `token` — the user pastes a credential into the card, and the RPC's return
 *   value says whether it worked. Cloudflare.
 * - `browser` — the host opens a sign-in and the answer arrives later, on a
 *   host event. GitHub's device code, Atlassian's and Google's OAuth.
 */
export type ConnectionCompletion = 'token' | 'browser'

export const CONNECTION_COMPLETION: Record<ConnectionProvider, ConnectionCompletion> = {
  cloudflare: 'token',
  github: 'browser',
  atlassian: 'browser',
  google: 'browser',
}

/** Display names, so no surface has to invent its own capitalization. */
export const CONNECTION_LABELS: Record<ConnectionProvider, string> = {
  cloudflare: 'Cloudflare',
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
  | 'deploy'
  | 'pull-requests'
  | 'issues'
  | 'confluence'
  | 'jira'
  | 'drive'
  | 'unspecified'

export interface ConnectionConnectNeeded {
  provider: ConnectionProvider
  reason: ConnectionReason
  /** The Solus session whose turn is waiting on the connection. */
  sessionId: string
}

export function isConnectionProvider(value: string): value is ConnectionProvider {
  return (CONNECTION_PROVIDERS as readonly string[]).includes(value)
}
