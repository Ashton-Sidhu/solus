import { z } from 'zod'
import { integrationAuthSchema } from './integration-types'
import { oauthClientSchema, oauthTokenSchema } from './integrations/oauth-protocol'

/**
 * The cloud vault (docs/plans/cloud-vault.md): one store for a person's
 * credentials in Solus Cloud, named by one credential ref on both sides. This
 * module is the contract: the refs and their keys, the material the cloud keeps,
 * what an executor receives, and the bodies of every vault route (§2.3).
 */

// ── Routes ──────────────────────────────────────────────────────────────────

/** Executor routes: the person's delegated token as `Authorization: Bearer`, no cookie. */
export const VAULT_READ_PATH = '/v1/vault/read'
export const VAULT_CREDENTIAL_PATH = '/v1/vault/credential'
/** Account routes: the person's own account session or account token. */
export const ACCOUNT_VAULT_PATH = '/v1/account/vault'
export const ACCOUNT_VAULT_CONNECT_PATH = '/v1/account/vault/connect'
/** The one browser sign-in, for provider and MCP refs. */
export const VAULT_SIGN_IN_START_PATH = '/oauth/vault/start'
export const VAULT_SIGN_IN_CALLBACK_PATH = '/oauth/vault/callback'
/** Host-worker routes (the hosts token): seat refs only. */
export const vaultSeatsPath = (organizationId: string) => `/v1/orgs/${encodeURIComponent(organizationId)}/vault/seats`
export const vaultSeatPath = (userId: string) => `/v1/vault/seats/${encodeURIComponent(userId)}`

// ── Credential refs ─────────────────────────────────────────────────────────

export const vaultProviderSchema = z.enum(['github', 'google', 'atlassian'])
export type VaultProvider = z.infer<typeof vaultProviderSchema>
export const seatProviderSchema = z.enum(['claude-code', 'codex'])
export type SeatProvider = z.infer<typeof seatProviderSchema>

export const providerRefSchema = z.object({ kind: z.literal('provider'), provider: vaultProviderSchema }).strict()
export const mcpRefSchema = z.object({
  kind: z.literal('mcp'),
  /** The server's address as the person's profile names it. */
  serverUrl: z.string().min(1).max(2048).refine((value) => URL.canParse(value), 'not_a_url'),
}).strict()
export const typesafeRefSchema = z.object({ kind: z.literal('typesafe') }).strict()
export const seatRefSchema = z.object({ kind: z.literal('seat'), provider: seatProviderSchema }).strict()

/** What a credential is for: the same ref on the host and in the cloud. */
export const credentialRefSchema = z.discriminatedUnion('kind', [providerRefSchema, mcpRefSchema, typesafeRefSchema, seatRefSchema])
export type CredentialRef = z.infer<typeof credentialRefSchema>
export type ProviderRef = z.infer<typeof providerRefSchema>
export type McpRef = z.infer<typeof mcpRefSchema>
export type TypesafeRef = z.infer<typeof typesafeRefSchema>
export type SeatRef = z.infer<typeof seatRefSchema>

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The canonical string of a ref, the cloud table's key: `provider:github`,
 * `mcp:<sha256 hex of new URL(serverUrl).href>`, `typesafe`, `seat:claude-code`.
 * A rename of an MCP entry keeps its key; a different address is another server.
 */
export async function refKeyOf(ref: CredentialRef): Promise<string> {
  switch (ref.kind) {
    case 'provider':
      return `provider:${ref.provider}`
    case 'mcp':
      return `mcp:${await sha256Hex(new URL(ref.serverUrl).href)}`
    case 'typesafe':
      return 'typesafe'
    case 'seat':
      return `seat:${ref.provider}`
  }
}

// ── Material: what the cloud keeps, sealed ──────────────────────────────────

export const vaultMaterialKindSchema = z.enum(['oauth', 'key', 'cli-login'])
export type VaultMaterialKind = z.infer<typeof vaultMaterialKindSchema>

const atlassianSiteSchema = z.object({ id: z.string(), url: z.string().url(), name: z.string(), scopes: z.array(z.string()) })
export type AtlassianSite = z.infer<typeof atlassianSiteSchema>

/** A provider token from the cloud's own OAuth app, and its refresh token. Never leaves the cloud. */
export const providerOAuthMaterialSchema = z.object({
  kind: z.literal('oauth'),
  accessToken: z.string(),
  refreshToken: z.string().default(''),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
  login: z.string().optional(),
  sites: z.array(atlassianSiteSchema).optional(),
  selectedSiteId: z.string().nullable().optional(),
})
export type ProviderOAuthMaterial = z.infer<typeof providerOAuthMaterialSchema>

/** An MCP token with the client that received it and where to refresh and revoke it. */
export const mcpOAuthMaterialSchema = z.object({
  kind: z.literal('oauth'),
  token: oauthTokenSchema,
  client: oauthClientSchema,
  tokenEndpoint: z.string().min(1),
  /** The metadata address, so the cloud can discover the revocation endpoint. */
  discover: z.string().min(1),
}).strict()
export type McpOAuthMaterial = z.infer<typeof mcpOAuthMaterialSchema>

export const keySchemeSchema = z.enum(['bearer', 'basic', 'other', 'unspecified'])
export type KeyScheme = z.infer<typeof keySchemeSchema>

/** A pasted key: a TypeSafe key, or an MCP server's key with the scheme it takes. */
export const keyMaterialSchema = z.object({
  kind: z.literal('key'),
  key: z.string().min(1).max(4096),
  scheme: keySchemeSchema.optional(),
}).strict()
export type KeyMaterial = z.infer<typeof keyMaterialSchema>

/** `.credentials.json` and `auth.json` are small JSON objects; anything else is not a login. */
const MAX_CLI_LOGIN_BYTES = 64 * 1024
export const cliLoginFileSchema = z.string().max(MAX_CLI_LOGIN_BYTES).refine((text) => {
  try {
    return z.looseObject({}).safeParse(JSON.parse(text)).success
  } catch {
    return false
  }
}, 'not_a_login_file')

/** A CLI's whole login file, as the Claude Code or Codex CLI wrote it. */
export const cliLoginMaterialSchema = z.object({ kind: z.literal('cli-login'), file: cliLoginFileSchema }).strict()
export type CliLoginMaterial = z.infer<typeof cliLoginMaterialSchema>

/** What an executor may upload: never a provider token (§2.2). */
export const uploadMaterialSchema = z.union([mcpOAuthMaterialSchema, keyMaterialSchema, cliLoginMaterialSchema])
export type UploadMaterial = z.infer<typeof uploadMaterialSchema>

/** The material kinds each ref takes (§2.2). */
export function materialKindsOf(ref: CredentialRef): readonly VaultMaterialKind[] {
  switch (ref.kind) {
    case 'provider':
      return ['oauth']
    case 'mcp':
      return ['oauth', 'key']
    case 'typesafe':
      return ['key']
    case 'seat':
      return ['cli-login']
  }
}

/** Whether an executor may upload this ref: everything but a provider token, which belongs to the client that issued it. */
export const isUploadable = (ref: CredentialRef) => ref.kind !== 'provider'

// ── Delivery: what an executor receives for one use, never a refresh token ──

/** GitHub: the access token, its scopes, and the account's login. */
export const githubDeliverySchema = z.object({ accessToken: z.string(), scope: z.string(), login: z.string().optional() })
/** Google: an access token; `refreshToken` is always empty, as the host's provider readers expect. */
export const googleDeliverySchema = z.object({ accessToken: z.string(), refreshToken: z.literal(''), expiresAt: z.number(), scopes: z.array(z.string()) })
/** Atlassian: Google's shape and the site the person chose. */
export const atlassianDeliverySchema = googleDeliverySchema.extend({
  siteUrl: z.string(),
  cloudId: z.string(),
  siteName: z.string(),
  products: z.array(z.enum(['jira', 'confluence'])),
})
/** The header value to send to the server, and when it stops working. */
export const mcpDeliverySchema = z.object({ authorization: z.string().min(1), expiresAt: z.number().nullable(), label: z.string().nullable() })
export const typesafeDeliverySchema = z.object({ key: z.string().min(1) })
export const seatDeliverySchema = z.object({ file: cliLoginFileSchema, version: z.number().int().positive() })

export type GithubDelivery = z.infer<typeof githubDeliverySchema>
export type GoogleDelivery = z.infer<typeof googleDeliverySchema>
export type AtlassianDelivery = z.infer<typeof atlassianDeliverySchema>
export type McpDelivery = z.infer<typeof mcpDeliverySchema>
export type TypesafeDelivery = z.infer<typeof typesafeDeliverySchema>
export type SeatDelivery = z.infer<typeof seatDeliverySchema>
export type ProviderDelivery = GithubDelivery | GoogleDelivery | AtlassianDelivery

/** `POST /v1/vault/read`'s answer: its shape is the ref's (`deliverySchemaOf`). */
export const vaultDeliverySchema = z.union([
  atlassianDeliverySchema,
  googleDeliverySchema,
  githubDeliverySchema,
  mcpDeliverySchema,
  seatDeliverySchema,
  typesafeDeliverySchema,
])
export type VaultDelivery = z.infer<typeof vaultDeliverySchema>

/** The delivery schema for one ref. */
export function deliverySchemaOf(ref: CredentialRef): z.ZodType<VaultDelivery> {
  switch (ref.kind) {
    case 'provider':
      return { github: githubDeliverySchema, google: googleDeliverySchema, atlassian: atlassianDeliverySchema }[ref.provider]
    case 'mcp':
      return mcpDeliverySchema
    case 'typesafe':
      return typesafeDeliverySchema
    case 'seat':
      return seatDeliverySchema
  }
}

// ── Executor routes ─────────────────────────────────────────────────────────

/** `POST /v1/vault/read`: 200 the delivery; 404 `not_connected`; 409 `reconnect_required`. */
export const vaultReadRequestSchema = z.object({ ref: credentialRefSchema }).strict()
export type VaultReadRequest = z.infer<typeof vaultReadRequestSchema>

/**
 * `PUT /v1/vault/credential`: an executor's upload or write-back. `expectedVersion`
 * is the version on file, null for none. 201 `{ version }`; 409 `credential_held`;
 * 422 `credential_refused`; 403 `not_uploadable` for a provider ref.
 */
export const vaultUploadRequestSchema = z.object({
  ref: credentialRefSchema,
  material: uploadMaterialSchema,
  expectedVersion: z.number().int().positive().nullable(),
  label: z.string().max(256).nullable().optional(),
}).strict().refine(
  ({ ref, material }) => ref.kind === 'provider' || materialKindsOf(ref).includes(material.kind),
  'material_does_not_fit_ref',
)
export type VaultUploadRequest = z.infer<typeof vaultUploadRequestSchema>
export const vaultUploadResponseSchema = z.object({ version: z.number().int().positive() })

// ── Account routes ──────────────────────────────────────────────────────────

export const vaultCredentialStatusSchema = z.enum(['connected', 'needs-sign-in'])
export type VaultCredentialStatus = z.infer<typeof vaultCredentialStatusSchema>

/** One connection as the person and their clients see it: never the material. */
export const vaultConnectionSchema = z.object({
  ref: credentialRefSchema,
  material: vaultMaterialKindSchema,
  /** `needs-sign-in`: the cloud's refresh was refused, or a CLI's login was signed out. */
  status: vaultCredentialStatusSchema,
  /** The account name the provider or server reported. */
  label: z.string().nullable(),
  updatedAt: z.number(),
})
export type VaultConnection = z.infer<typeof vaultConnectionSchema>

/** `GET /v1/account/vault`. */
export const vaultConnectionListSchema = z.object({ connections: z.array(vaultConnectionSchema) })

/**
 * `POST /v1/account/vault/connect`. An MCP server the person's profile names signs
 * in as the profile says; any other public HTTPS server as `auth` says (a host probed it).
 */
export const vaultConnectRequestSchema = z.object({
  ref: credentialRefSchema,
  auth: integrationAuthSchema.optional(),
}).strict()
export type VaultConnectRequest = z.infer<typeof vaultConnectRequestSchema>

export const vaultConnectResultSchema = z.discriminatedUnion('kind', [
  /** Open this in a browser signed in to the account; the sign-in lands on the cloud. */
  z.object({ kind: z.literal('browser'), url: z.string().min(1) }),
  /** The ref takes a pasted key: send it with `PUT /v1/account/vault`. */
  z.object({ kind: z.literal('key') }),
  /** No sign-in: an open MCP server. */
  z.object({ kind: z.literal('none') }),
])
export type VaultConnectResult = z.infer<typeof vaultConnectResultSchema>

/** `PUT /v1/account/vault`: a pasted key for `typesafe` or an MCP server. `scheme` is for a server the profile does not name. */
export const vaultSaveKeyRequestSchema = z.object({
  ref: z.discriminatedUnion('kind', [mcpRefSchema, typesafeRefSchema]),
  key: z.string().min(1).max(4096),
  scheme: keySchemeSchema.optional(),
}).strict()
export type VaultSaveKeyRequest = z.infer<typeof vaultSaveKeyRequestSchema>

/** `DELETE /v1/account/vault`. */
export const vaultDisconnectRequestSchema = z.object({ ref: credentialRefSchema }).strict()
export type VaultDisconnectRequest = z.infer<typeof vaultDisconnectRequestSchema>

// ── Host-worker routes: seat refs only ──────────────────────────────────────

/** One member's CLI login, as `GET /v1/orgs/:organizationId/vault/seats` lists it. */
export const vaultSeatSchema = z.object({
  userId: z.string().min(1),
  ref: seatRefSchema,
  file: cliLoginFileSchema,
  version: z.number().int().positive(),
})
export type VaultSeat = z.infer<typeof vaultSeatSchema>
export const vaultSeatListSchema = z.object({ seats: z.array(vaultSeatSchema) })

/** `PUT /v1/vault/seats/:userId`: a write-back after the CLI refreshed. 200 `{ version }`; 409 `credential_held`. */
export const vaultSeatWriteRequestSchema = z.object({
  organizationId: z.string().min(1),
  ref: seatRefSchema,
  file: cliLoginFileSchema,
  expectedVersion: z.number().int().positive().nullable(),
}).strict()
export type VaultSeatWriteRequest = z.infer<typeof vaultSeatWriteRequestSchema>

// ── Errors ──────────────────────────────────────────────────────────────────

export const vaultErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  /** The person has no credential for the ref. */
  'not_connected',
  /** The cloud's refresh was refused, or there is nothing to refresh with: the person signs in again. */
  'reconnect_required',
  /** An upload named a version that is not the one on file. */
  'credential_held',
  /** The material failed its proof at the server. */
  'credential_refused',
  /** A provider token belongs to the client that issued it. */
  'not_uploadable',
  /** The ref takes no browser sign-in or no key, or this cloud has no OAuth app for the provider. */
  'not_available',
  /** An MCP server the person's profile does not name, and the request named no usable one. */
  'server_not_in_profile',
  /** The server's sign-in could not start. */
  'sign_in_unavailable',
  /** A host worker wrote for a person who is not a member of its organization. */
  'not_a_member',
])
export type VaultErrorCode = z.infer<typeof vaultErrorCodeSchema>

export const vaultErrorBodySchema = z.object({ error: vaultErrorCodeSchema, message: z.string().optional() })
export type VaultErrorBody = z.infer<typeof vaultErrorBodySchema>
export const vaultCredentialHeldBodySchema = z.object({ error: z.literal('credential_held'), currentVersion: z.number().int().nullable() })
export type VaultCredentialHeldBody = z.infer<typeof vaultCredentialHeldBodySchema>
