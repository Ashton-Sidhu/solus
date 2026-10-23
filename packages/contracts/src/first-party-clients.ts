import { z } from 'zod'
import { GITHUB_OAUTH_SCOPES } from './github-auth'
import { GOOGLE_OAUTH_SCOPES } from './google-auth'

/**
 * First-party clients (docs/plans/mcp-integrations.md §13.1): the OAuth apps
 * Solus itself registered with a vendor. An integration whose authorization
 * server is one of these signs in through Solus's app, so the person enters no
 * client. Matched by the server's own endpoints, never chosen by a person.
 * Where the credential lives follows the rule every credential follows
 * (plans/020-agent-profile.md §5.1).
 *
 * - `github`: the person's Solus GitHub connection (a device-flow token from
 *   Solus's GitHub app) is the credential; there is no second sign-in.
 * - `google`: the integration's own OAuth sign-in runs with Solus's Google
 *   desktop app instead of a client the person enters.
 */
export const firstPartyClientIdSchema = z.enum(['github', 'google'])
export type FirstPartyClientId = z.infer<typeof firstPartyClientIdSchema>

/**
 * Every Google scope Solus's Google app may hold: Executor v2's Google set
 * (UsefulSoftwareCo/executor, `first-party-oauth.ts`; Calendar, Meet, Gmail,
 * Sheets, Drive, Docs, Slides, Forms, Tasks, People, Photos, and Search
 * Console), plus the narrower Calendar scopes Solus's Calendar server asks
 * for. Google reports `email` and `profile` under their `userinfo` names, so
 * both are listed. A scope here must also be declared on the app's Data Access
 * page in the Google Cloud console.
 */
const GOOGLE_INTEGRATION_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'https://www.googleapis.com/auth/meetings.space.settings',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
  'https://www.googleapis.com/auth/user.addresses.read',
  'https://www.googleapis.com/auth/user.birthday.read',
  'https://www.googleapis.com/auth/user.emails.read',
  'https://www.googleapis.com/auth/user.gender.read',
  'https://www.googleapis.com/auth/user.organization.read',
  'https://www.googleapis.com/auth/user.phonenumbers.read',
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
  'https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata',
  'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
  'https://www.googleapis.com/auth/webmasters',
] as const

/** A server's authorization endpoints, as its metadata publishes them. */
export interface AuthorizationServerEndpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
}

interface FirstPartyClientDefinition extends AuthorizationServerEndpoints {
  id: FirstPartyClientId
  /** Shown in place of the client form, as "Sign in with <label>". */
  label: string
  /** Every scope a sign-in may ask for and a grant may hold. */
  allowedScopes: readonly string[]
  /**
   * The vendor's own remote MCP servers, by host: the only remote servers the
   * app's tokens may go to. Any other server that names the vendor's
   * authorization server gets no first-party sign-in, so it never receives a
   * token of Solus's app. A Solus MCP server for the vendor sends its tokens
   * only to the vendor's API hosts.
   */
  mcpHosts: readonly string[]
}

/** The address scheme of a Solus MCP server (`solus:<id>`, §13.6). */
const SOLUS_SERVER_SCHEME = 'solus:'

/** One OAuth app Solus registered with a vendor, and what it may do. */
export class FirstPartyClient {
  constructor(private readonly definition: FirstPartyClientDefinition) {}

  get id(): FirstPartyClientId {
    return this.definition.id
  }

  get label(): string {
    return this.definition.label
  }

  /** Whether an authorization server is exactly this vendor's: its own endpoints, never a look-alike. */
  isAuthorizationServer(server: AuthorizationServerEndpoints): boolean {
    return this.definition.authorizationEndpoint === server.authorizationEndpoint && this.definition.tokenEndpoint === server.tokenEndpoint
  }

  /**
   * Whether this app's tokens may go to the server at `url`: a Solus MCP
   * server, or one of the vendor's own MCP hosts. Any other server can name
   * the vendor's authorization server, and must not get Solus's app.
   */
  serves(url: string): boolean {
    if (url.startsWith(SOLUS_SERVER_SCHEME)) return true
    return URL.canParse(url) && this.definition.mcpHosts.includes(new URL(url).hostname)
  }

  /** The requested scopes this app may ask for; the rest are left out (§13.1). */
  scopesAllowed(requested: readonly string[]): string[] {
    return requested.filter((scope) => this.definition.allowedScopes.includes(scope))
  }
}

export const FIRST_PARTY_CLIENTS: readonly FirstPartyClient[] = [
  new FirstPartyClient({
    id: 'github',
    label: 'Solus for GitHub',
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    allowedScopes: GITHUB_OAUTH_SCOPES,
    mcpHosts: ['api.githubcopilot.com'],
  }),
  new FirstPartyClient({
    id: 'google',
    label: 'Solus for Google',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    allowedScopes: [...new Set([...GOOGLE_OAUTH_SCOPES, ...GOOGLE_INTEGRATION_SCOPES])],
    // Google publishes no remote MCP server; its servers are Solus's own.
    mcpHosts: [],
  }),
]

/** The first-party client whose endpoints an authorization server publishes, or null. Exact match only. */
export function firstPartyClientFor(server: AuthorizationServerEndpoints): FirstPartyClient | null {
  return FIRST_PARTY_CLIENTS.find((client) => client.isAuthorizationServer(server)) ?? null
}

export function firstPartyClientById(id: FirstPartyClientId): FirstPartyClient {
  const client = FIRST_PARTY_CLIENTS.find((candidate) => candidate.id === id)
  if (!client) throw new Error(`No first-party client ${id}.`)
  return client
}
