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
 * Browser sign-in is the only way in. Atlassian has no public-client mode, so
 * the flow needs a client secret shipped with the build; a build without one
 * cannot connect at all, which `oauthAvailable` reports.
 */

/** An Atlassian product Solus can reach with the stored grant. */
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
}

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
