/**
 * Personal Uplink — the public contract between a Solus host, its clients, and the
 * Solus control plane (docs/plans/personal-uplink.md). The schemas are the contract:
 * every side decodes with them and derives its types from them, so the wire cannot
 * drift from the code. The control plane keeps a verbatim copy of this file
 * (`bun run contracts:sync` there); this file must therefore import nothing but zod.
 * Nothing here is a secret and nothing is a constant of one deployment: issuer, JWKS,
 * and directory URLs reach the host in `UplinkLinkConfig` when it links.
 */

import { z } from 'zod'

/**
 * A person's access token lives five minutes (plans/010-standard-oauth.md): the
 * account plane is an OAuth 2.1 authorization server, hosts and the Solus API check
 * its JWT access tokens offline, and a short life is how removal reaches them. A
 * host's delegated tokens refresh on their own, so a short life costs them nothing.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 300

/**
 * The resource (RFC 8707) of one host: the `aud` of an access token for it. A host
 * refuses a token for another host, so a token one host received cannot open another.
 */
export function hostAudience(hostId: string): string {
  return `urn:solus:host:${hostId}`
}

const HOST_AUDIENCE_PREFIX = 'urn:solus:host:'

/** The host an audience names, or null when it names no host. */
export function hostIdOfAudience(audience: string): string | null {
  if (!audience.startsWith(HOST_AUDIENCE_PREFIX)) return null
  const hostId = audience.slice(HOST_AUDIENCE_PREFIX.length)
  return hostId.length > 0 ? hostId : null
}

/** The resource of the account plane's own routes a host calls as a person (connections). */
export const ACCOUNT_AUDIENCE = 'urn:solus:account'

/**
 * The resource of the control plane's host routes (`/v1/hosts/:hostId/...`): what a
 * host's own access token is for. The host gets it with the client credentials grant
 * and its host credential (docs/adr/0001-standard-authentication.md §2.2 rule 8). It
 * is never a person's token and never a delegated one.
 */
export const CONTROL_AUDIENCE = 'urn:solus:control'

/** The one scope a host's own access token has: it manages the host's own link. */
export const HOST_CONTROL_SCOPE = 'host:link'

/** The Solus API's OAuth client: a confidential client with `private_key_jwt`, as a host is (ADR 0001 §6.2). */
export const SOLUS_API_CLIENT_ID = 'solus-api'

/** A host's OAuth client id. One client per host: linking again replaces it. */
export function hostClientId(hostId: string): string {
  return `host_${hostId}`
}

/** RFC 7523 §2.2: a client authenticates at the token endpoint with a signed JWT. */
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/**
 * The public half of a host credential (RFC 7517): an ES256 key on P-256. The host
 * makes the key pair and keeps the private half; the control plane registers only
 * this half as the host client's `jwks`.
 */
export const hostPublicJwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().min(1),
  y: z.string().min(1),
  alg: z.literal('ES256').optional(),
  kid: z.string().min(1).optional(),
  use: z.literal('sig').optional(),
}).strict()
export type HostPublicJwk = z.infer<typeof hostPublicJwkSchema>

/**
 * Where a host trades a person's access token for its own delegated tokens (token
 * exchange, RFC 8693) and refreshes them: the account plane's OAuth token endpoint.
 */
export function tokenEndpoint(directoryUrl: string): string {
  return `${new URL(directoryUrl).origin}/api/auth/oauth2/token`
}

/** The RFC 8693 grant and token types a host uses. */
export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange'
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'

/**
 * What a grant admits to: a person's own machine, one the control plane provisioned
 * for an organization, or the cloud workspace service that serves every
 * organization (docs/plans/cloud-service-model.md). `cloud` names that service in a
 * grant and in the service's own identity only. It is never a host: the directory
 * lists the service apart from the machines (`directoryWorkspaceSchema`).
 */
export const hostKindSchema = z.enum(['personal', 'managed', 'cloud'])
export type HostKind = z.infer<typeof hostKindSchema>

/** The kinds of machine a directory lists: a person's own, or one managed for an organization. */
export const machineKindSchema = z.enum(['personal', 'managed'])
export type MachineKind = z.infer<typeof machineKindSchema>

/**
 * What kind of machine a host is, as the control plane recorded it at enrollment
 * (organization-scope §3.1). A `personal` host is the desktop app's own execution
 * host; a `self-hosted` host is a registered standalone Solus server; a `managed`
 * host is one the control plane provisioned. An organization's `allowsPersonalHosts`
 * policy refuses only the first. The host process declares `personal` or
 * `self-hosted` when it enrolls; a renderer, a label, or a later request cannot
 * change it.
 */
export const hostCategorySchema = z.enum(['personal', 'self-hosted', 'managed'])
export type HostCategory = z.infer<typeof hostCategorySchema>
export const enrollHostCategorySchema = z.enum(['personal', 'self-hosted'])
export type EnrollHostCategory = z.infer<typeof enrollHostCategorySchema>

/**
 * What an organization's owners decided (organization-scope §3.1, §6.1). Every
 * client and host reads the same three facts; only the account website changes them.
 * `syncAllInsights` on means every session of the organization sends its Insights;
 * off leaves that to managed machines, explicit sharing, and a client opt-in.
 */
export const organizationPolicySchema = z.object({
  allowsCloudHosts: z.boolean(),
  allowsPersonalHosts: z.boolean(),
  syncAllInsights: z.boolean(),
})
export type OrganizationPolicy = z.infer<typeof organizationPolicySchema>

/** An organization that never set a policy. */
export const DEFAULT_ORGANIZATION_POLICY: OrganizationPolicy = {
  allowsCloudHosts: true,
  allowsPersonalHosts: true,
  syncAllInsights: true,
}

// ── Workspace service ────────────────────────────────────────────────────────

/** The resource of the Solus API: the `aud` of every token for it. The organization rides in the claims. */
export const SOLUS_API_AUDIENCE = 'urn:solus:api'

/** The id of an organization's workspace service: `workspace:<organizationId>`. A grant for the service names it, and a client keys its connection by it. */
export const SOLUS_API_ID_PREFIX = 'workspace:'

export function solusApiId(organizationId: string): string {
  return `${SOLUS_API_ID_PREFIX}${organizationId}`
}

/** The organization behind a workspace service id, or null when the id is a machine's. */
export function organizationIdOfSolusApiId(id: string): string | null {
  if (!id.startsWith(SOLUS_API_ID_PREFIX)) return null
  const organizationId = id.slice(SOLUS_API_ID_PREFIX.length)
  return organizationId.length > 0 ? organizationId : null
}

/** Whether a connection id names a workspace service rather than a machine. */
export function isSolusApiId(id: string | null | undefined): boolean {
  return !!id && organizationIdOfSolusApiId(id) !== null
}

/**
 * What the token says about the subject's standing on the host
 * (docs/plans/multiplayer-sharing.md §3.2). `owner` is the personal host's owner;
 * `org-member` a member of an organization the host belongs to. A guest holds no
 * token: a share link's secret admits them (docs/plans/host-sharing.md §4.1).
 */
export const grantAccessSchema = z.enum(['owner', 'org-member'])
export type GrantAccess = z.infer<typeof grantAccessSchema>

export const organizationRoleSchema = z.enum(['owner', 'member'])
export type OrganizationRole = z.infer<typeof organizationRoleSchema>

/** A subject may be in many teams; the claim stays small. */
export const MAX_TEAM_IDS_PER_GRANT = 32
/** A typed display name: trimmed, no control characters, 1–40 characters. */
export const MAX_DISPLAY_NAME_LENGTH = 40

/**
 * The actor of a delegated token (RFC 8693 §4.1): the host, or the Solus API, that
 * acts for the person the token names. A delegated token is what a host holds for a
 * person's work after their clients closed.
 */
export const tokenActorSchema = z.object({
  /** The actor's OAuth client id: a host's, or `SOLUS_API_CLIENT_ID`. */
  sub: z.string().min(1),
  /** The acting host. Absent when the actor is the Solus API, whose delegated tokens are for the account plane only. */
  host_id: z.string().min(1).optional(),
})
export type TokenActor = z.infer<typeof tokenActorSchema>

/** One organization in an access token: the person's role and teams there (ADR 0001 §6.4). */
export const organizationMembershipClaimSchema = z.object({
  id: z.string().min(1),
  role: organizationRoleSchema,
  teamIds: z.array(z.string().min(1)).max(MAX_TEAM_IDS_PER_GRANT),
})
export type OrganizationMembershipClaim = z.infer<typeof organizationMembershipClaimSchema>

/** The claims of every access token (RFC 9068) the account plane issues. ES256; `kid` in the header. */
const accessTokenBaseShape = {
  iss: z.string().min(1),
  /** `hostAudience(hostId)`, `SOLUS_API_AUDIENCE`, or `ACCOUNT_AUDIENCE`; a delegated token names the last two. */
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  /** The account's user id. */
  sub: z.string().min(1),
  jti: z.string().min(1),
  iat: z.number(),
  /** ≤ iat + ACCESS_TOKEN_TTL_SECONDS. */
  exp: z.number(),
  /** The OAuth client the token was issued to. */
  client_id: z.string().min(1).optional(),
  access: grantAccessSchema.optional(),
  hostKind: hostKindSchema.optional(),
  /** Personal hosts only: the account that linked the host. */
  hostOwnerUserId: z.string().min(1).optional(),
  /** What kind of machine the token admits to; absent on a Solus API token. */
  hostCategory: hostCategorySchema.optional(),
  /** The account name. */
  displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH).optional(),
  picture: z.string().min(1).optional(),
  /** The account's verified email, for Insights attribution (§6.1). Metadata, never an authorization key. */
  email: z.string().min(1).optional(),
}

/**
 * A person's token: a Solus client got it with its refresh token
 * (docs/adr/0001-standard-authentication.md §3.1). The provider owns `sub`,
 * `client_id`, and `scope`; the membership facts are Solus's own claims.
 */
export const personAccessTokenClaimsSchema = z.object({
  ...accessTokenBaseShape,
  /** The client grant (one sign-in of one Solus client) the token comes from; revoking it stops new tokens. */
  grant_id: z.string().min(1),
  /**
   * The person's memberships that apply to the audience (ADR 0001 §6.4). For a host,
   * the organizations the host is shared with or managed for; for the Solus API, all
   * of them. A connection names one, and the server admits it only when the token lists it.
   */
  organizations: z.array(organizationMembershipClaimSchema).optional(),
  act: z.undefined().optional(),
})
export type PersonAccessTokenClaims = z.infer<typeof personAccessTokenClaimsSchema>

/** What every delegated token (RFC 8693) has: the acting host, and the client grant it was made from. */
const delegatedBaseShape = {
  ...accessTokenBaseShape,
  /** Delegated tokens only: the host acting for the person (token exchange). */
  act: tokenActorSchema,
  /** The client grant the host's delegation was made from; when it is revoked, the delegation ends (ADR 0001 §2.2 rule 6). */
  grant_id: z.string().min(1),
  organizations: z.undefined().optional(),
}

/**
 * A delegated token (RFC 8693): what a host holds to act for a person after their
 * clients closed. Its scope is the person's own host (`access: 'owner'`, no
 * organization) or one organization (`org-member`, with the person's standing
 * there). The acting host is in `act`.
 */
export const delegatedAccessTokenClaimsSchema = z.union([
  z.object({
    ...delegatedBaseShape,
    access: z.literal('owner'),
    organizationId: z.undefined().optional(),
    organizationRole: z.undefined().optional(),
    teamIds: z.undefined().optional(),
  }),
  z.object({
    ...delegatedBaseShape,
    access: z.literal('org-member'),
    organizationId: z.string().min(1),
    organizationRole: organizationRoleSchema,
    /** Teams of this person inside that organization. */
    teamIds: z.array(z.string().min(1)).max(MAX_TEAM_IDS_PER_GRANT),
  }),
])
export type DelegatedAccessTokenClaims = z.infer<typeof delegatedAccessTokenClaimsSchema>

/** Any access token of the account plane: a delegated one when it has `act`, else a person's. */
export const accessTokenClaimsSchema = z.union([delegatedAccessTokenClaimsSchema, personAccessTokenClaimsSchema])
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>

/** Every audience a token names. */
export function tokenAudiences(claims: Pick<AccessTokenClaims, 'aud'>): string[] {
  return Array.isArray(claims.aud) ? claims.aud : [claims.aud]
}

/** Trims, strips control characters, and bounds a typed name; null when nothing usable remains. */
export function normalizeDisplayName(value: string | undefined): string | null {
  if (!value) return null
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[ -]/g, '').trim().slice(0, MAX_DISPLAY_NAME_LENGTH)
  return cleaned.length > 0 ? cleaned : null
}

const hostOperatingSystemSchema = z.enum(['macos', 'windows', 'linux'])

/** Non-secret link record kept on the host. Never constants. */
export const uplinkLinkConfigSchema = z.object({
  hostId: z.string().min(1),
  issuer: z.string().min(1),
  jwksUrl: z.string().min(1),
  /** Origin of the `/v1` API the host calls for its own link record. */
  directoryUrl: z.string().min(1),
  /** `h-<hostId>.<tunnelDomain>`; the tunnel route is `https://` + this. */
  hostname: z.string().min(1),
  /** Loopback port the connector forwards to; never a trusted requester. */
  proxiedPort: z.number().int().positive(),
  /** Advances on every enroll and delete. A host with an older value is superseded. */
  connectionGeneration: z.number().int().nonnegative(),
  /**
   * Managed hosts only: the organization Solus provisioned the machine for. A link
   * that names one is a managed host's; no other link carries it.
   */
  organizationId: z.string().min(1).optional(),
  /**
   * The Solus API the account plane names for organization records, fixed when the
   * host linked. Delivery and organization records go only here, so a changed
   * setting cannot move records or queued delivery (organization-vms §5).
   */
  apiUrl: z.string().min(1).optional(),
})
export type UplinkLinkConfig = z.infer<typeof uplinkLinkConfigSchema>

export const uplinkDesiredStateSchema = z.enum(['linked', 'unlinked'])
export type UplinkDesiredState = z.infer<typeof uplinkDesiredStateSchema>

/** What the host's own connector reports; never leaves the host. */
export const uplinkObservedStateSchema = z.enum(['online', 'offline', 'error'])
export type UplinkObservedState = z.infer<typeof uplinkObservedStateSchema>

export const uplinkLinkStateSchema = z.object({
  observed: uplinkObservedStateSchema,
  error: z.string().optional(),
})
export type UplinkLinkState = z.infer<typeof uplinkLinkStateSchema>

// ── Managed hosts (docs/plans/managed-hosts.md) ──────────────────────────────

/**
 * What the control plane wants of a managed host's compute. `deleted` is terminal:
 * the record stays only until every cloud resource is confirmed gone.
 */
export const managedHostDesiredStateSchema = z.enum(['running', 'stopped', 'deleted'])
export type ManagedHostDesiredState = z.infer<typeof managedHostDesiredStateSchema>

/**
 * What a person sees. Derived on every read from the provider's machine state and the
 * link; nothing stores it. A machine that is not yet started is `starting`, not `ready`.
 */
export const managedHostLifecycleSchema = z.enum([
  'provisioning',
  'starting',
  'ready',
  'stopping',
  'stopped',
  'failed',
  'deleting',
])
export type ManagedHostLifecycle = z.infer<typeof managedHostLifecycleSchema>

/** A `direct` route is dialed before the `tunnel`; an `http:` route is unusable from an `https:` page. */
export const hostRouteSchema = z.object({
  kind: z.enum(['direct', 'tunnel']),
  url: z.string().min(1),
})
export type HostRoute = z.infer<typeof hostRouteSchema>

/**
 * One machine in `GET /v1/hosts`: the tunnel route only; direct routes are the client's
 * own knowledge. The workspace service is never a row here (`directoryWorkspaceSchema`).
 * `routes` is empty until the host is linked, and every route listed resolves: a client
 * given a name before its DNS record exists keeps "no such name" after it does. A client
 * dials only what the latest directory read lists and saves no route of its own for it.
 */
export const directoryHostSchema = z.object({
  hostId: z.string().min(1),
  installationId: z.string().min(1),
  label: z.string(),
  os: hostOperatingSystemSchema.optional().catch(undefined),
  routes: z.array(hostRouteSchema),
  kind: machineKindSchema,
  category: hostCategorySchema,
  /** The account that linked a personal host; absent on a managed host. */
  ownerUserId: z.string().min(1).optional().catch(undefined),
  /** The owner's display name, so a shared host's row can say whose machine it is without a directory read. */
  ownerName: z.string().min(1).optional().catch(undefined),
  /**
   * The organizations whose members may reach this host through grants: the ones a
   * personal host is shared with, or the one a managed host belongs to (§3.1, R15).
   */
  organizationIds: z.array(z.string().min(1)),
  /** Managed hosts only: what the control plane knows of the compute. A client dials a `ready` host and shows the rest as a state. */
  managedState: managedHostLifecycleSchema.optional().catch(undefined),
})
export type DirectoryHost = z.infer<typeof directoryHostSchema>

/**
 * One organization's workspace service in `GET /v1/hosts`, listed apart from the
 * machines (docs/plans/workspace-and-machines.md §4): a cloud service where the
 * organization's records live, never a host and never a place work runs. `routes` is
 * the one tunnel to the service every organization shares. `isActive` marks the
 * organization the caller is working in: the active organization of their account
 * session, or the first by name when none is chosen. Exactly one entry carries it.
 */
export const directoryWorkspaceSchema = z.object({
  organizationId: z.string().min(1),
  label: z.string(),
  routes: z.array(hostRouteSchema),
  isActive: z.boolean(),
  /** The organization's current policy, so a client can show it beside its content. */
  policy: organizationPolicySchema,
})
export type DirectoryWorkspace = z.infer<typeof directoryWorkspaceSchema>

// ── `/v1` request and response bodies ────────────────────────────────────────

export const directoryResponseSchema = z.object({
  hosts: z.array(directoryHostSchema),
  workspaces: z.array(directoryWorkspaceSchema),
})
export type DirectoryResponse = z.infer<typeof directoryResponseSchema>

/**
 * `POST /v1/enrollment-tickets` body. With organizations, the ticket also attaches
 * the host to them for organization work when it is redeemed (organization-vms §4).
 * The account must be a member of each one when the ticket is issued and again
 * when it is redeemed. An absent body issues a personal account link.
 */
export const enrollmentTicketRequestSchema = z.object({
  organizationIds: z.array(z.string().min(1)).min(1).max(16).optional(),
})
export type EnrollmentTicketRequest = z.infer<typeof enrollmentTicketRequestSchema>

export const enrollmentTicketResponseSchema = z.object({
  /** One use, ten minutes. Handed to the host over an already-trusted local connection. */
  ticket: z.string().min(1),
  expiresAt: z.number(),
  /** The organizations the ticket attaches the host to; empty for a personal link. */
  organizationIds: z.array(z.string().min(1)).optional(),
})
export type EnrollmentTicketResponse = z.infer<typeof enrollmentTicketResponseSchema>

/**
 * The code a person copies to link a host: the ticket and the account plane that
 * issued it, as `<ticket>@<host>`. The account plane is https, except on loopback
 * for development. One string carries everything `solus setup --link` needs.
 */
export function formatLinkCode(ticket: string, accountOrigin: string): string {
  return `${ticket}@${new URL(accountOrigin).host}`
}

/** A link code split into its ticket and account origin; a bare ticket keeps `fallbackOrigin`. Throws on anything else. */
export function parseLinkCode(code: string, fallbackOrigin: string): UplinkLinkRequest {
  const trimmed = code.trim()
  const at = trimmed.lastIndexOf('@')
  if (at < 0) {
    if (!trimmed) throw new Error('The link code is empty.')
    return { ticket: trimmed, directoryUrl: new URL(fallbackOrigin).origin }
  }
  const ticket = trimmed.slice(0, at)
  const host = trimmed.slice(at + 1)
  if (!ticket || !host || /[/\s?#]/.test(host)) throw new Error('The link code is not valid. Copy it again from Solus.')
  const hostname = host.replace(/:\d+$/, '')
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  return { ticket, directoryUrl: new URL(`${loopback ? 'http' : 'https'}://${host}`).origin }
}

export const enrollHostRequestSchema = z.object({
  ticket: z.string().min(1),
  installationId: z.string().min(1),
  label: z.string().min(1).max(120),
  os: hostOperatingSystemSchema.optional(),
  proxiedPort: z.number().int().min(1).max(65535),
  /** What the enrolling process is; `personal` when absent. Recorded once, at enrollment. */
  category: enrollHostCategorySchema.optional(),
  /** The public half of the host credential the host made for this link (ADR 0001 §3.4). Each link has a new one. */
  publicJwk: hostPublicJwkSchema,
})
export type EnrollHostRequest = z.infer<typeof enrollHostRequestSchema>

/** Returned once. The host keeps the connector token in its secret store, beside the private half of its key. */
export const enrollHostResponseSchema = z.object({
  link: uplinkLinkConfigSchema,
  /**
   * `cloudflared` credential; tunnel only, never an API credential. Absent when the
   * host is reached directly: a managed host's platform proxy forwards its URL to the
   * proxied listener, so there is no tunnel to run.
   */
  connectorToken: z.string().min(1).optional(),
  /**
   * The host's OAuth client: a confidential client of the account plane with
   * `private_key_jwt` and the key the request sent. With it the host gets its own
   * access tokens (client credentials) and acts for the people who work on it (token
   * exchange). There is no secret: the host proves itself with its key.
   */
  oauthClient: z.object({ clientId: z.string().min(1) }),
  /** The organizations this enrollment attached the host to for organization work; absent for a personal link. */
  organizationIds: z.array(z.string().min(1)).optional(),
})
export type EnrollHostResponse = z.infer<typeof enrollHostResponseSchema>

/**
 * `POST /v1/hosts/:hostId/organizations/attach` with the host's control token: a linked host
 * redeems an organization-bound ticket its owner issued, and is attached to those
 * organizations for organization work. The host is not enrolled again and no
 * record moves (organization-vms §4).
 */
export const hostAttachRequestSchema = z.object({
  ticket: z.string().min(1),
})
export type HostAttachRequest = z.infer<typeof hostAttachRequestSchema>

export const hostAttachResponseSchema = z.object({
  organizationIds: z.array(z.string().min(1)).min(1),
})
export type HostAttachResponse = z.infer<typeof hostAttachResponseSchema>

/** `POST /v1/hosts/<hostId>/start`: the lifecycle a managed host is in after a
 *  member asked it to run. The client waits for the directory to say `ready`. */
export const managedHostStartResponseSchema = z.object({
  lifecycle: managedHostLifecycleSchema.nullable(),
})

// ── Managed host specs and the size catalog ─────────────────────────────────

/** An apt package name, as Debian allows it; nothing a shell could read as more. */
export const MANAGED_HOST_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]{0,127}$/
export const MAX_MANAGED_HOST_PACKAGES = 64
/** 16 KiB: a setup script, not a payload. */
export const MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH = 16_384

/**
 * What a person asks of a managed host: a generic Linux machine. Every field is
 * optional: an absent size is the catalog's default, so "create a host" with nothing
 * chosen makes the generic one. Where the machine runs is Solus Cloud's business, not
 * part of the spec. Packages are installed, then the setup script is run, after the
 * Solus release is installed and before the server starts, on the first boot after
 * either changes. A failed setup keeps the host from starting.
 */
export const managedHostSpecRequestSchema = z.object({
  size: z.string().min(1).max(64).optional(),
  packages: z
    .array(z.string().regex(MANAGED_HOST_PACKAGE_PATTERN))
    .max(MAX_MANAGED_HOST_PACKAGES)
    .optional(),
  setupScript: z.string().max(MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH).optional(),
})
export type ManagedHostSpecRequest = z.infer<typeof managedHostSpecRequestSchema>

/** One size a managed host may have. CPU and memory are absent when the machine grows on its own. */
export const managedHostSizeSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  detail: z.string(),
  cpus: z.number().positive().optional().catch(undefined),
  memoryGb: z.number().positive().optional().catch(undefined),
})
export type ManagedHostSize = z.infer<typeof managedHostSizeSchema>

/**
 * What a new managed host may be: its sizes, the default first, and whether packages
 * and a setup script are offered. No sizes when Solus Cloud cannot make hosts. A picker
 * with one size has nothing to ask.
 */
export const managedHostCatalogSchema = z.object({
  sizes: z.array(managedHostSizeSchema),
  defaultSize: z.string().min(1).nullable(),
  supportsPackages: z.boolean(),
  supportsSetupScript: z.boolean(),
})
export type ManagedHostCatalog = z.infer<typeof managedHostCatalogSchema>

/** `POST /v1/hosts` with the account session: a member creates the organization's
 *  managed host. The label defaults to "Cloud host"; an absent spec is the default one. */
export const createManagedHostRequestSchema = z.object({
  organizationId: z.string().min(1),
  label: z.string().trim().min(1).max(120).optional(),
  spec: managedHostSpecRequestSchema.optional(),
})
export type CreateManagedHostRequest = z.infer<typeof createManagedHostRequestSchema>

export const createManagedHostResponseSchema = z.object({
  hostId: z.string().min(1),
})

/** One organization of the signed-in account, as cloud onboarding reads it. */
export const accountOrganizationSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string(),
  role: organizationRoleSchema,
  /** The caller may create this organization's managed host now: member, allowlisted, allowed by its policy, none yet. */
  mayCreateManagedHost: z.boolean(),
  /** The organization's policy (§3.1, §6.1). */
  policy: organizationPolicySchema,
})
export type AccountOrganization = z.infer<typeof accountOrganizationSchema>

/** `GET /v1/account`: what cloud onboarding needs to know about the signed-in account. */
export const accountResponseSchema = z.object({
  userId: z.string().min(1),
  /** When the account finished or skipped cloud onboarding (epoch ms); null before. */
  onboardingCompletedAt: z.number().nullable(),
  activeOrganizationId: z.string().min(1).nullable(),
  organizations: z.array(accountOrganizationSchema),
  /** What a new cloud host may be, for onboarding's "Size" picker; absent from an older control plane. */
  managedHostCatalog: managedHostCatalogSchema.optional().catch(undefined),
  /** The account's GitHub connection, made on its Connections page; null when not connected, absent from an older control plane. */
  github: z.object({ login: z.string().nullable() }).nullable().optional().catch(undefined),
})
export type AccountResponse = z.infer<typeof accountResponseSchema>

/** The account that linked a personal or self-hosted host, as the control plane knows it. */
export const hostOwnerIdentitySchema = z.object({
  userId: z.string().min(1),
  email: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
})
export type HostOwnerIdentity = z.infer<typeof hostOwnerIdentitySchema>

/** One organization a host may deliver records to, and whether the machine itself is shared with it. */
export const hostOrganizationSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string(),
  /** Members of the organization may reach this machine through grants. */
  shared: z.boolean(),
  policy: organizationPolicySchema,
  /**
   * Every current member's user id, sent only for an organization the machine is
   * shared with. A person who is not in it was removed: the host removes their seats
   * and ends their sockets (plan 004 item 10). Absent from an older control plane,
   * and then the host removes nothing.
   */
  memberUserIds: z.array(z.string().min(1)).optional(),
})
export type HostOrganization = z.infer<typeof hostOrganizationSchema>

/**
 * `GET /v1/hosts/:hostId/organizations` with the host's control token: what the control plane
 * knows about this host's standing (§3, §3.1, §6.1) — its category, the account that
 * linked it, and the organizations it may deliver to with each one's policy. A host
 * reads it at link time and again every few minutes, so a policy change reaches it
 * without a restart.
 */
export const hostOrganizationsResponseSchema = z.object({
  hostId: z.string().min(1),
  category: hostCategorySchema,
  /** Null on a managed host: nobody's machine. */
  owner: hostOwnerIdentitySchema.nullable(),
  organizations: z.array(hostOrganizationSchema),
})
export type HostOrganizationsResponse = z.infer<typeof hostOrganizationsResponseSchema>

/**
 * `PUT /v1/hosts/:hostId/activity` with the host's control token, from a managed host only (plan
 * 004 item 3). The machine holds itself awake while it is busy; the control plane
 * uses the report to wake a paused machine before `nextWakeAt` and to put off a
 * restart for a new release or spec while `busy`. Sent when either value changes, and
 * again at least every hour: a report older than that says nothing.
 */
export const hostActivityReportSchema = z.object({
  /** A turn runs, or a permission, question or plan waits for a person. */
  busy: z.boolean(),
  /** When the next scheduled automation is due (epoch ms); null when none is. */
  nextWakeAt: z.number().int().nonnegative().nullable(),
})
export type HostActivityReport = z.infer<typeof hostActivityReportSchema>
/** How long a host activity report stands; the host renews it before then. */
export const HOST_ACTIVITY_REPORT_TTL_MS = 90 * 60_000

// ── Organizations and guests ─────────────────────────────────────────────────

/**
 * `POST /v1/hosts/:hostId/organizations`: the owner shares a personal or self-hosted
 * host with one more organization they belong to; `DELETE
 * /v1/hosts/:hostId/organizations/:organizationId` takes it back. A host may be shared
 * with several organizations at once, each independently (R15).
 */
export const hostShareRequestSchema = z.object({
  organizationId: z.string().min(1),
})
export type HostShareRequest = z.infer<typeof hostShareRequestSchema>

/** One person in an organization's directory, as the share dialog lists them. */
export const directoryMemberSchema = z.object({
  userId: z.string().min(1),
  name: z.string(),
  email: z.string().optional(),
  image: z.string().nullable().optional(),
  role: organizationRoleSchema,
})
export type DirectoryMember = z.infer<typeof directoryMemberSchema>

export const directoryTeamSchema = z.object({
  teamId: z.string().min(1),
  name: z.string(),
  memberUserIds: z.array(z.string().min(1)),
})
export type DirectoryTeam = z.infer<typeof directoryTeamSchema>

/** `GET /v1/orgs/:organizationId/directory`, cached by the client for the session. */
export const organizationDirectorySchema = z.object({
  organizationId: z.string().min(1),
  name: z.string(),
  members: z.array(directoryMemberSchema),
  teams: z.array(directoryTeamSchema),
})
export type OrganizationDirectory = z.infer<typeof organizationDirectorySchema>

/**
 * Every host route takes the host's own access token as `Authorization: Bearer`:
 * a client credentials token for `CONTROL_AUDIENCE`, issued to this host's client
 * for the current link. A token of an earlier link, or of another host, is refused
 * with `invalid_host_credential`.
 */

/** `GET /v1/hosts/:id/link` with the host's control token: the generation check at boot. */
export const hostLinkResponseSchema = z.object({
  hostId: z.string().min(1),
  desired: uplinkDesiredStateSchema,
  connectionGeneration: z.number().int().nonnegative(),
  hostname: z.string().min(1),
  proxiedPort: z.number().int().positive(),
})
export type HostLinkResponse = z.infer<typeof hostLinkResponseSchema>

// ── Provisioned host link ────────────────────────────────────────────────────

/**
 * How a host the control plane provisioned gets its link (docs/plans/managed-hosts.md
 * §2): the control plane hands the link record and a one-time credential ticket to the
 * host's boot, which puts them in the server's environment as JSON (`SOLUS_HOST_LINK`).
 * At its first boot of that link the host makes its own key pair and registers the
 * public half with the ticket (`POST /v1/hosts/:hostId/credential`). The private key
 * never leaves the machine, and the ticket works once, so nothing that passes through
 * the provisioner proves the host after its first boot (ADR 0001 §3.4). Such a link
 * has no connector token: the machine is reached through its platform URL, not a tunnel.
 */
export const hostLinkEnvSchema = z.object({
  link: uplinkLinkConfigSchema,
  credentialTicket: z.string().min(1),
})
export type HostLinkEnv = z.infer<typeof hostLinkEnvSchema>
export const HOST_LINK_ENV = 'SOLUS_HOST_LINK'

/**
 * `POST /v1/hosts/:hostId/credential`: a provisioned host registers the public half of
 * its key with the ticket its link carries. The ticket works once. The same key sent
 * again is accepted, so a host whose answer was lost can ask again.
 */
export const hostCredentialRequestSchema = z.object({
  credentialTicket: z.string().min(1),
  publicJwk: hostPublicJwkSchema,
})
export type HostCredentialRequest = z.infer<typeof hostCredentialRequestSchema>

export const hostCredentialResponseSchema = z.object({
  oauthClient: z.object({ clientId: z.string().min(1) }),
})
export type HostCredentialResponse = z.infer<typeof hostCredentialResponseSchema>

export const uplinkErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'invalid_ticket',
  /** The host's control token is not of this host's current link: another copy took the link, or it was removed. */
  'invalid_host_credential',
  'cross_origin',
  'host_not_found',
  'host_not_linked',
  'not_a_member',
  'organization_not_found',
  'rate_limited',
  'tunnel_provisioning_failed',
  'tunnel_not_configured',
  'tunnel_account_limit',
  'managed_hosts_not_configured',
  'managed_host_limit',
  'managed_provisioning_failed',
  'refused_by_host_policy',
  'workspace_not_configured',
  'host_not_in_organization',
  /** The organization does not allow personal hosts (§3.1): no link, grant, or run for it on this machine. */
  'personal_hosts_not_allowed',
  /** An organization ticket was redeemed with a user grant that is not this host's, has expired, or names nobody. */
  'invalid_user_grant',
  /** A settings write named a revision that is no longer current; the body carries the current document. */
  'settings_conflict',
  /** Synced settings were cleared since this client last read them; it must turn sync on again. */
  'settings_generation_changed',
  /** Only an organization owner may change its settings. */
  'not_settings_manager',
])
export type UplinkErrorCode = z.infer<typeof uplinkErrorCodeSchema>

/** Every `/v1` error body. */
export const uplinkErrorBodySchema = z.object({
  error: uplinkErrorCodeSchema.or(z.string()),
  message: z.string().optional(),
})

// ── Host RPC (local-owner only) ──────────────────────────────────────────────

/** The owner's client hands the host a ticket and tells it where the directory is. */
export interface UplinkLinkRequest {
  ticket: string
  /** The account origin that issued the ticket, e.g. `https://app.solus.sh`. */
  directoryUrl: string
}

export const uplinkStatusSchema = z.discriminatedUnion('linked', [
  /** `error`: the stored link Solus cloud no longer accepts, and why. Linking again replaces it. */
  z.object({ linked: z.literal(false), error: z.string().optional() }),
  z.object({
    linked: z.literal(true),
    link: uplinkLinkConfigSchema,
    state: uplinkLinkStateSchema,
  }),
])
export type UplinkStatus = z.infer<typeof uplinkStatusSchema>

// ── Client shell (desktop main / cloud-served web) ───────────────────────────

/** What a client needs to link a host: the ticket and where it came from. */
export interface UplinkEnrollmentTicket extends EnrollmentTicketResponse {
  directoryUrl: string
}

/** The account's host directory, with the origin it belongs to. */
export interface UplinkDirectory {
  directoryUrl: string
  hosts: DirectoryHost[]
  workspaces: DirectoryWorkspace[]
}
