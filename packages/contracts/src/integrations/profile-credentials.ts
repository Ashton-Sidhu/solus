import { z } from 'zod'
import { integrationAuthSchema } from '../integration-types'
import { oauthClientSchema, oauthTokenSchema } from './oauth-protocol'

/**
 * A person's MCP connections in their account (plans/020-agent-profile.md §5,
 * solus-cloud/docs/plans/agent-profile.md §3 to §5): what a host uploads once
 * when sync reaches a connection it already holds, what a host reads per call,
 * and what a client sees. A credential is keyed by the server URL, never by a
 * host's record id, so a rename keeps the connection and every host finds it.
 */

export const PROFILE_CREDENTIAL_PATH = '/v1/agent-profile/credential'
export const PROFILE_CONNECTIONS_PATH = '/v1/account/agent-profile/connections'
export const PROFILE_OAUTH_CALLBACK_PATH = '/oauth/integration/callback'

/** The sealed material, as a host uploads it and the cloud keeps it. Never answered to anyone. */
export const profileCredentialSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bearer'),
    key: z.string().min(1),
    scheme: z.enum(['bearer', 'basic', 'other', 'unspecified']),
  }).strict(),
  z.object({
    kind: z.literal('oauth'),
    token: oauthTokenSchema,
    /** The client that received the token: a host's registration, carried so the cloud can refresh with it. */
    client: oauthClientSchema,
    tokenEndpoint: z.string().min(1),
    /** The metadata address, so the cloud can discover the revocation endpoint. */
    discover: z.string().min(1),
  }).strict(),
])
export type ProfileCredential = z.infer<typeof profileCredentialSchema>

/**
 * `PUT /v1/agent-profile/credential` from a host: the reconcile upload. `expectedVersion: null` creates; a held one answers 409.
 * Every executor route takes the person's delegated token as `Authorization: Bearer`, never in the body (ADR 0001 §2.2 rule 7).
 */
export const profileCredentialUploadRequestSchema = z.object({
  serverUrl: z.string().min(1),
  expectedVersion: z.number().int().nullable(),
  credential: profileCredentialSchema,
  label: z.string().nullable().optional(),
}).strict()
export type ProfileCredentialUploadRequest = z.input<typeof profileCredentialUploadRequestSchema>

export const profileCredentialUploadResponseSchema = z.object({ version: z.number().int() })
export const profileCredentialConflictBodySchema = z.object({ error: z.literal('credential_held'), currentVersion: z.number().int().nullable() })

/** `POST /v1/agent-profile/credential` from a host: the current credential for one call, refreshed by the cloud when due. */
export const profileCredentialReadRequestSchema = z.object({
  serverUrl: z.string().min(1),
}).strict()

/** What a host receives: the header value to send to the server, and when it stops working. Never the refresh token or the client. */
export const profileCredentialDeliverySchema = z.object({
  authorization: z.string().min(1),
  expiresAt: z.number().nullable(),
  label: z.string().nullable(),
})
export type ProfileCredentialDelivery = z.infer<typeof profileCredentialDeliverySchema>

/** One connection as the person and their hosts see it: never the material. */
export const profileConnectionSchema = z.object({
  serverUrl: z.string().min(1),
  kind: z.enum(['oauth', 'bearer']),
  /** `needs-sign-in`: the cloud's refresh was refused, or the key was rejected. */
  status: z.enum(['connected', 'needs-sign-in']),
  label: z.string().nullable(),
  updatedAt: z.number(),
})
export type ProfileConnection = z.infer<typeof profileConnectionSchema>

export const profileConnectionListSchema = z.object({ connections: z.array(profileConnectionSchema) })

/**
 * `POST /v1/account/agent-profile/connections`: a signed-in person starts a sign-in
 * to one server. A server of their profile signs in as the profile names it; any
 * other server, such as a host's shared one, as `auth` says, which the host probed.
 */
export const profileConnectStartRequestSchema = z.object({ serverUrl: z.string().min(1), auth: integrationAuthSchema.optional() }).strict()
export type ProfileConnectStartRequest = z.infer<typeof profileConnectStartRequestSchema>
export const profileConnectStartResultSchema = z.discriminatedUnion('kind', [
  /** Open this in the browser; the callback lands on the cloud. */
  z.object({ kind: z.literal('browser'), url: z.string().min(1) }),
  /** The server takes a pasted key: send it with `PUT`. */
  z.object({ kind: z.literal('token') }),
  /** No sign-in: the server is open. */
  z.object({ kind: z.literal('none') }),
])
export type ProfileConnectStartResult = z.infer<typeof profileConnectStartResultSchema>

/** `PUT /v1/account/agent-profile/connections`: a pasted key, checked against the server before it is sealed. `scheme` is for a server the profile does not name. */
export const profileConnectKeyRequestSchema = z.object({ serverUrl: z.string().min(1), key: z.string().min(1).max(4096), scheme: z.enum(['bearer', 'basic', 'other', 'unspecified']).optional() }).strict()
export type ProfileConnectKeyRequest = z.infer<typeof profileConnectKeyRequestSchema>

/** `DELETE /v1/account/agent-profile/connections`. */
export const profileDisconnectRequestSchema = z.object({ serverUrl: z.string().min(1) }).strict()
export type ProfileDisconnectRequest = z.infer<typeof profileDisconnectRequestSchema>
