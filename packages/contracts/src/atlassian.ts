/**
 * The Atlassian site connection: one account, one site, two products.
 *
 * Confluence (documents) and Jira (tasks) live on the same Atlassian site and
 * are reached with the same grant, so Solus connects the *site* once and lets
 * both feature layers read that one credential. `cloudId` — not the hostname —
 * is the durable site identity, because every external key that gets persisted
 * later (`<cloudId>/<spaceKey>`, `<cloudId>/<projectKey>`) is built from it and
 * a site can be renamed.
 *
 * Browser sign-in is the usual way in. Atlassian has no public-client mode, so
 * the flow needs a client secret shipped with the build, which `oauthAvailable`
 * reports. The fallback is an API token the user pastes from their Atlassian
 * profile: it works on any build, and on sites whose admin blocks OAuth apps.
 */

export type AtlassianProduct = 'confluence' | 'jira'

export interface AtlassianStatus {
  connected: boolean
  /** The site origin the grant reaches, e.g. `https://acme.atlassian.net`. */
  siteUrl?: string
  cloudId?: string
  /** The site's display name, as Atlassian reports it. */
  siteName?: string
  /** Which products the granted scopes reach. Empty means neither. */
  products?: AtlassianProduct[]
  /** Whether this build ships an OAuth client. When false there is no way to
   *  connect, and the UI says so rather than offering a button that fails. */
  oauthAvailable?: boolean
  /** Whether this host takes a pasted API token. Absent from an older host, and
   *  false where the account website owns the connection. */
  apiTokenAvailable?: boolean
  /** How the connected site was connected. */
  authMethod?: 'oauth' | 'apiToken'
}

/** What a user pastes to connect without a browser sign-in. The token is
 *  created at id.atlassian.com and acts as the account the email names. */
export interface AtlassianApiTokenInput {
  /** `acme`, `acme.atlassian.net`, or any link on the site. */
  siteUrl: string
  email: string
  apiToken: string
}

export const ATLASSIAN_API_TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens'

export type AtlassianApiTokenConnectResult =
  | { ok: true }
  | { ok: false; error: string }

/** A Jira project on the connected site, as the task-provider picker lists it.
 *  `key` is the durable half of a task `externalKey` (`<cloudId>/<projectKey>`);
 *  `name` is only ever shown. */
export interface AtlassianJiraProject {
  key: string
  name: string
}

export type AtlassianOAuthStartResult =
  | { ok: true; authUrl: string; expiresAt: number }
  | { ok: false; error: string }

/** Broadcast when a browser flow finishes, so every mounted client updates
 *  without polling — the tab that started it may not be the one in front. */
export interface AtlassianOAuthCompleted {
  connected: boolean
  error?: string
}
